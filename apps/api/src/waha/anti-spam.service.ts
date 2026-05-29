import { Injectable, Logger, HttpException, HttpStatus, Inject, OnModuleInit } from '@nestjs/common';
import { eq, isNull, sql, and } from 'drizzle-orm';
import { wahaSessions } from '@wago/db';
import { DRIZZLE_TOKEN } from '../database/database.module';

/**
 * AntiSpamService — centralizes all WhatsApp anti-detection logic.
 *
 * WHY THIS EXISTS:
 * WhatsApp's servers use a mix of heuristics to flag automation:
 *   1. Message velocity (too many msgs/sec from one number)
 *   2. Uniform inter-message delays (bots always wait exactly 1 s)
 *   3. Sending to many distinct recipients in a short window
 *   4. A brand-new number sending bulk traffic immediately (warmup detection)
 *   5. Rapid, repeated reconnections (session churn)
 *   6. Missing "online" presence signals before and after activity
 *   7. Sending to same contact many times without any incoming activity
 *
 * None of these rules are published by WhatsApp. They are inferred from
 * community bans + reverse-engineering of WA Web traffic. The mitigations
 * implemented here are the industry-standard set used by providers like
 * Wati, MessageBird, and 360dialog.
 */
@Injectable()
export class AntiSpamService implements OnModuleInit {
  private readonly logger = new Logger(AntiSpamService.name);

  constructor(@Inject(DRIZZLE_TOKEN) private readonly db: any) {}

  async onModuleInit() {
    await this.restoreWarmupFromDb();
  }

  // ─── Per-session rate-limit windows ───────────────────────────────────────
  // Key: `${sessionId}:${chatId}` → timestamps of recent sends
  private readonly recipientWindows = new Map<string, number[]>();

  // Key: `${sessionId}` → timestamps of ALL recent sends (global per-session)
  private readonly sessionWindows = new Map<string, number[]>();

  // ─── Warmup tracking ──────────────────────────────────────────────────────
  // Key: sessionId → { connectedAt, totalSent }
  private readonly warmupState = new Map<
    string,
    { connectedAt: number; totalSent: number }
  >();

  // ─── Reconnection cooldown ────────────────────────────────────────────────
  // Key: sessionId → last restart timestamp
  private readonly lastRestart = new Map<string, number>();

  // ─── Config constants ─────────────────────────────────────────────────────
  /**
   * Max messages to ANY recipient within a 1-minute window per session.
   * Humans typically send 3–8 msgs/min in busy conversations.
   * Setting 20/min gives room for bursts while blocking obvious spam.
   */
  private readonly SESSION_MAX_PER_MINUTE = 20;

  /**
   * Max messages to the SAME recipient within a 5-minute window.
   * Sending 10+ consecutive messages to one person without a reply
   * is a strong spam signal.
   */
  private readonly RECIPIENT_MAX_PER_5MIN = 8;

  /**
   * Minimum gap between two consecutive messages to the same chat (ms).
   * 2 s is barely plausible for a human; anything under ~1 s is robotic.
   */
  private readonly MIN_INTER_MESSAGE_MS = 2_000;

  /**
   * Warmup day limits: index = days since connected.
   * Day 0 → 10 msgs max, Day 1 → 30, Day 2 → 80, Day 3+ → unlimited.
   * Sources: industry practice, WABotWorld & Maytapi whitepapers.
   */
  private readonly WARMUP_DAILY_LIMITS = [10, 30, 80, 200, Infinity];

  /**
   * Minimum seconds between session restarts.
   * Restarting a session more than once every 5 min triggers WA's
   * "session cycling" heuristic used to detect disposable-number spam.
   */
  private readonly RESTART_COOLDOWN_MS = 5 * 60 * 1_000;

  // ─── Public API ───────────────────────────────────────────────────────────

  /**
   * Call this BEFORE every sendText / sendImage / etc.
   * Throws TooManyRequestsException if any limit is breached.
   * Returns the humanized delay (ms) that the caller should await
   * in addition to any typing simulation already done.
   */
  async checkAndThrottle(
    sessionId: string,
    chatId: string,
    messageLength = 50,
  ): Promise<number> {
    const now = Date.now();

    // 1. Global session rate-limit
    this.enforceSessionRateLimit(sessionId, now);

    // 2. Per-recipient batch protection
    this.enforceRecipientRateLimit(sessionId, chatId, now);

    // 3. Warmup gate
    this.enforceWarmupLimit(sessionId);

    // 4. Compute humanized delay based on message length
    const delay = this.humanDelay(messageLength);

    // 5. Record the send (after all checks pass)
    this.recordSend(sessionId, chatId, now);

    return delay;
  }

  /**
   * Register a session as newly connected.
   * Must be called when a session transitions to WORKING status so warmup
   * tracking starts from day 0.
   */
  markSessionConnected(sessionId: string): void {
    // In-memory warmup (fast path)
    if (!this.warmupState.has(sessionId)) {
      this.warmupState.set(sessionId, { connectedAt: Date.now(), totalSent: 0 });
      this.logger.log(`Session ${sessionId} entered warmup mode`);
    }
    // Persist to DB so warmup survives API restarts
    this.db
      .update(wahaSessions)
      .set({ warmupConnectedAt: new Date() })
      .where(and(eq(wahaSessions.id, sessionId), isNull(wahaSessions.warmupConnectedAt)))
      .catch(() => { /* non-critical */ });
  }

  /**
   * Check whether a session restart is safe.
   * Returns true if allowed, false if still in cooldown.
   * Call this before every resetSession / restartSession.
   */
  canRestart(sessionId: string): boolean {
    const last = this.lastRestart.get(sessionId);
    if (!last) return true;
    const elapsed = Date.now() - last;
    if (elapsed < this.RESTART_COOLDOWN_MS) {
      const remaining = Math.ceil((this.RESTART_COOLDOWN_MS - elapsed) / 1_000);
      this.logger.warn(
        `Session ${sessionId} restart throttled — cooldown ${remaining}s remaining`,
      );
      return false;
    }
    return true;
  }

  /**
   * Record that a session restart just happened.
   */
  recordRestart(sessionId: string): void {
    this.lastRestart.set(sessionId, Date.now());
  }

  /**
   * How long the warmup day delay should be (ms) before sending a batch,
   * based on day-of-warmup. Returns 0 once fully warmed up.
   */
  getWarmupBatchDelay(sessionId: string): number {
    const state = this.warmupState.get(sessionId);
    if (!state) return 0;
    const daysSince = this.daysSince(state.connectedAt);
    if (daysSince >= this.WARMUP_DAILY_LIMITS.length - 1) return 0;
    // Extra inter-message delay during warmup: 3 s on day 0, 2 s on day 1, 1 s on day 2
    const extras = [3_000, 2_000, 1_000, 500, 0];
    return extras[Math.min(daysSince, extras.length - 1)] ?? 0;
  }

  /**
   * Generate a human-like inter-message delay.
   * Formula: base jitter (800–2200 ms) + typing rate (30–60 ms/char, capped 4 s).
   * The randomness is deliberately non-uniform (log-normal-ish) to avoid
   * detection via statistical timing analysis.
   */
  humanDelay(messageLength: number): number {
    const base = 800 + Math.random() * 1_400; // 800–2200 ms
    const typingRate = 30 + Math.random() * 30; // 30–60 ms/char
    const typing = Math.min(messageLength * typingRate, 4_000);
    // Occasional "thinking" pause (20% chance, adds 1–3 s)
    const thinkingPause = Math.random() < 0.2 ? 1_000 + Math.random() * 2_000 : 0;
    return Math.round(base + typing + thinkingPause);
  }

  /**
   * Delay (ms) to simulate reading a message before responding.
   * 500 ms – 2 s, log-skewed toward shorter values.
   */
  readDelay(): number {
    return Math.round(500 + Math.random() * 1_500);
  }

  // ─── Private helpers ──────────────────────────────────────────────────────

  private enforceSessionRateLimit(sessionId: string, now: number): void {
    const window = this.getOrCreate(this.sessionWindows, sessionId);
    // Evict entries older than 1 minute
    const oneMinAgo = now - 60_000;
    const fresh = window.filter((t) => t > oneMinAgo);
    this.sessionWindows.set(sessionId, fresh);

    if (fresh.length >= this.SESSION_MAX_PER_MINUTE) {
      const oldest = fresh[0];
      const retryAfter = Math.ceil((oldest + 60_000 - now) / 1_000);
      this.logger.warn(
        `Session ${sessionId} hit rate limit (${fresh.length}/${this.SESSION_MAX_PER_MINUTE} per min). Retry in ${retryAfter}s`,
      );
      throw new HttpException(
        `Rate limit: max ${this.SESSION_MAX_PER_MINUTE} messages/min. Retry in ${retryAfter}s.`,
        HttpStatus.TOO_MANY_REQUESTS,
      );
    }
  }

  private enforceRecipientRateLimit(
    sessionId: string,
    chatId: string,
    now: number,
  ): void {
    const key = `${sessionId}:${chatId}`;
    const window = this.getOrCreate(this.recipientWindows, key);
    const fiveMinAgo = now - 5 * 60_000;
    const fresh = window.filter((t) => t > fiveMinAgo);
    this.recipientWindows.set(key, fresh);

    // Minimum inter-message gap check
    if (fresh.length > 0) {
      const lastSent = fresh[fresh.length - 1];
      const gap = now - lastSent;
      if (gap < this.MIN_INTER_MESSAGE_MS) {
        throw new HttpException(
          `Too fast: wait at least ${this.MIN_INTER_MESSAGE_MS / 1_000}s between messages to the same chat.`,
          HttpStatus.TOO_MANY_REQUESTS,
        );
      }
    }

    if (fresh.length >= this.RECIPIENT_MAX_PER_5MIN) {
      this.logger.warn(
        `Session ${sessionId} → chat ${chatId}: batch limit (${fresh.length}/${this.RECIPIENT_MAX_PER_5MIN} in 5 min)`,
      );
      throw new HttpException(
        `Batch limit: max ${this.RECIPIENT_MAX_PER_5MIN} messages per contact in 5 min. Slow down.`,
        HttpStatus.TOO_MANY_REQUESTS,
      );
    }
  }

  private enforceWarmupLimit(sessionId: string): void {
    const state = this.warmupState.get(sessionId);
    if (!state) return; // session not in warmup tracking → no limit

    const daysSince = this.daysSince(state.connectedAt);
    const limit = this.WARMUP_DAILY_LIMITS[Math.min(daysSince, this.WARMUP_DAILY_LIMITS.length - 1)];

    if (limit === Infinity) {
      // Fully warmed up — remove from map to save memory
      this.warmupState.delete(sessionId);
      return;
    }

    // Daily counter: reset by tracking connectedAt and using floor(daysSince) as epoch
    // Simple approach: count total sends and compare against accumulated limit
    const accumulatedLimit = this.WARMUP_DAILY_LIMITS
      .slice(0, Math.min(daysSince + 1, this.WARMUP_DAILY_LIMITS.length))
      .reduce((sum, v) => sum + (v === Infinity ? 0 : v), 0);

    if (state.totalSent >= accumulatedLimit) {
      this.logger.warn(
        `Session ${sessionId} warmup limit reached: ${state.totalSent}/${accumulatedLimit} on day ${daysSince}`,
      );
      throw new HttpException(
        `Warmup limit: this connection has reached its daily message limit (day ${daysSince + 1} of warmup). ` +
          `Limit increases each day. Current cap: ${limit} msgs/day total.`,
        HttpStatus.TOO_MANY_REQUESTS,
      );
    }
  }

  private recordSend(sessionId: string, chatId: string, now: number): void {
    // Session window
    const sessionW = this.getOrCreate(this.sessionWindows, sessionId);
    sessionW.push(now);

    // Recipient window
    const key = `${sessionId}:${chatId}`;
    const recipientW = this.getOrCreate(this.recipientWindows, key);
    recipientW.push(now);

    // Warmup counter — in-memory
    const state = this.warmupState.get(sessionId);
    if (state) state.totalSent++;

    // Persist to DB (fire-and-forget, non-critical)
    this.db
      .update(wahaSessions)
      .set({ warmupTotalSent: sql`${wahaSessions.warmupTotalSent} + 1` })
      .where(eq(wahaSessions.id, sessionId))
      .catch(() => { /* non-critical */ });
  }

  /**
   * Restore warmup state from DB after API restart.
   * Call this on module init to reload any sessions that were mid-warmup.
   */
  async restoreWarmupFromDb(): Promise<void> {
    try {
      const sessions = await this.db
        .select()
        .from(wahaSessions)
        .where(eq(wahaSessions.status, 'working'));
      for (const s of sessions) {
        if (s.warmupConnectedAt && !this.warmupState.has(s.id)) {
          this.warmupState.set(s.id, {
            connectedAt: s.warmupConnectedAt.getTime(),
            totalSent: s.warmupTotalSent ?? 0,
          });
        }
      }
      this.logger.log(`Restored warmup state for ${sessions.length} sessions from DB`);
    } catch { /* non-critical on startup */ }
  }

  private getOrCreate(map: Map<string, number[]>, key: string): number[] {
    if (!map.has(key)) map.set(key, []);
    return map.get(key)!;
  }

  private daysSince(timestamp: number): number {
    return Math.floor((Date.now() - timestamp) / (24 * 60 * 60 * 1_000));
  }
}
