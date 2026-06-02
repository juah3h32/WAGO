import { Injectable, Logger, Inject, NotFoundException } from '@nestjs/common';
import { eq, and } from 'drizzle-orm';
import { aiResponderConfigs, wahaSessions, wahaWorkers } from '@wago/db';
import { DRIZZLE_TOKEN } from '../database/database.module';
import { WahaService } from '../waha/waha.service';
import { AntiSpamService } from '../waha/anti-spam.service';

export interface UpsertAiResponderDto {
  enabled?: boolean;
  provider?: string;
  model?: string;
  apiKey?: string;
  systemPrompt?: string;
  maxTokens?: number;
}

export interface AiResponderJobData {
  connectionId: string;
  sessionId: string;
  userId: string;
  chatId: string;
  incomingMessage: string;
  workerInternalIp?: string;
  workerApiKey?: string;
  sessionName?: string;
}

@Injectable()
export class AiResponderService {
  private readonly logger = new Logger(AiResponderService.name);

  constructor(
    @Inject(DRIZZLE_TOKEN) private readonly db: any,
    private readonly wahaService: WahaService,
    private readonly antiSpamService: AntiSpamService,
  ) {}

  async getConfig(connectionId: string, userId: string) {
    const rows = await this.db
      .select()
      .from(aiResponderConfigs)
      .where(
        and(
          eq(aiResponderConfigs.connectionId, connectionId),
          eq(aiResponderConfigs.userId, userId),
        ),
      )
      .limit(1);
    return rows[0] ?? null;
  }

  async upsertConfig(connectionId: string, userId: string, dto: UpsertAiResponderDto) {
    const existing = await this.getConfig(connectionId, userId);

    if (existing) {
      const [updated] = await this.db
        .update(aiResponderConfigs)
        .set({
          ...dto,
          updatedAt: new Date(),
        })
        .where(eq(aiResponderConfigs.id, existing.id))
        .returning();
      return updated;
    }

    const [created] = await this.db
      .insert(aiResponderConfigs)
      .values({
        connectionId,
        userId,
        enabled: dto.enabled ?? false,
        provider: dto.provider ?? 'anthropic',
        model: dto.model ?? 'claude-haiku-4-5-20251001',
        apiKey: dto.apiKey ?? null,
        systemPrompt: dto.systemPrompt ?? null,
        maxTokens: dto.maxTokens ?? 500,
      })
      .returning();
    return created;
  }

  async testConfig(connectionId: string, userId: string): Promise<{ success: boolean; response?: string; error?: string }> {
    const config = await this.getConfig(connectionId, userId);
    if (!config) {
      return { success: false, error: 'No AI responder config found for this connection' };
    }
    if (!config.apiKey) {
      return { success: false, error: 'No API key configured' };
    }

    try {
      const testMessages = [{ role: 'user' as const, content: 'Hello! This is a test message.' }];
      const response = await this.callAiApi(config, testMessages);
      return { success: true, response };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return { success: false, error: message };
    }
  }

  async processIncomingMessage(data: AiResponderJobData): Promise<void> {
    const { connectionId, userId, chatId, incomingMessage, workerInternalIp, workerApiKey, sessionName } = data;

    // 1. Load config — skip if not enabled or missing
    const config = await this.getConfig(connectionId, userId);
    if (!config || !config.enabled || !config.apiKey) {
      this.logger.debug(`AI responder disabled or unconfigured for connection ${connectionId}`);
      return;
    }

    // Resolve worker info from DB if not provided in job
    let resolvedIp = workerInternalIp;
    let resolvedApiKey = workerApiKey;
    let resolvedSessionName = sessionName;

    if (!resolvedIp || !resolvedApiKey || !resolvedSessionName) {
      const sessions = await this.db
        .select()
        .from(wahaSessions)
        .where(eq(wahaSessions.id, connectionId))
        .limit(1);
      const session = sessions[0];
      if (!session) {
        this.logger.warn(`Session ${connectionId} not found — skipping AI response`);
        return;
      }
      resolvedSessionName = resolvedSessionName ?? session.sessionName;

      if (session.workerId) {
        const workers = await this.db
          .select()
          .from(wahaWorkers)
          .where(eq(wahaWorkers.id, session.workerId))
          .limit(1);
        const worker = workers[0];
        if (worker) {
          resolvedIp = resolvedIp ?? worker.internalIp;
          resolvedApiKey = resolvedApiKey ?? worker.apiKeyEnc;
        }
      }
    }

    if (!resolvedIp || !resolvedApiKey || !resolvedSessionName) {
      this.logger.warn(`Missing worker info for connection ${connectionId} — skipping AI response`);
      return;
    }

    // 2. Load last 10 messages from Evolution API for conversation context
    let conversationMessages: { role: 'user' | 'assistant'; content: string }[] = [];
    try {
      const history = await this.wahaService.getMessages(resolvedIp, resolvedApiKey, resolvedSessionName, chatId);
      const recentMessages = history
        .filter((m) => m.body && m.body.trim())
        .slice(-10);

      conversationMessages = recentMessages.map((m) => ({
        role: m.fromMe ? ('assistant' as const) : ('user' as const),
        content: m.body,
      }));
    } catch (err) {
      this.logger.warn(`Could not load message history for ${connectionId}:${chatId} — using incoming only`);
      conversationMessages = [{ role: 'user', content: incomingMessage }];
    }

    // Ensure the latest incoming message is present (may not be in history yet)
    const lastMsg = conversationMessages[conversationMessages.length - 1];
    if (!lastMsg || lastMsg.role !== 'user' || lastMsg.content !== incomingMessage) {
      conversationMessages.push({ role: 'user', content: incomingMessage });
    }

    // 3. Call AI API
    let aiResponse: string;
    try {
      aiResponse = await this.callAiApi(config, conversationMessages);
    } catch (err) {
      this.logger.error(`AI API call failed for connection ${connectionId}: ${err instanceof Error ? err.message : String(err)}`);
      return;
    }

    if (!aiResponse || !aiResponse.trim()) {
      this.logger.warn(`AI returned empty response for connection ${connectionId}`);
      return;
    }

    // 4. Anti-spam throttle check
    try {
      await this.antiSpamService.checkAndThrottle(connectionId, chatId, aiResponse.length);
    } catch (err) {
      this.logger.warn(`Anti-spam throttle blocked AI response for ${connectionId}:${chatId}: ${err instanceof Error ? err.message : String(err)}`);
      return;
    }

    // 5. Send typing presence indicator + send message
    try {
      await this.wahaService.sendText(
        resolvedIp,
        resolvedApiKey,
        resolvedSessionName,
        chatId,
        aiResponse,
      );
      this.logger.log(`AI response sent to ${chatId} on connection ${connectionId}`);
    } catch (err) {
      this.logger.error(`Failed to send AI response for ${connectionId}: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  private async callAiApi(
    config: { provider: string; model: string; apiKey: string; systemPrompt?: string | null; maxTokens: number },
    messages: { role: 'user' | 'assistant'; content: string }[],
  ): Promise<string> {
    if (config.provider === 'openai') {
      return this.callOpenAi(config, messages);
    }
    return this.callAnthropic(config, messages);
  }

  private async callAnthropic(
    config: { model: string; apiKey: string; systemPrompt?: string | null; maxTokens: number },
    messages: { role: 'user' | 'assistant'; content: string }[],
  ): Promise<string> {
    const response = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': config.apiKey,
        'anthropic-version': '2023-06-01',
      },
      body: JSON.stringify({
        model: config.model,
        max_tokens: config.maxTokens,
        system: config.systemPrompt || 'You are a helpful WhatsApp assistant.',
        messages,
      }),
    });

    if (!response.ok) {
      const body = await response.text();
      throw new Error(`Anthropic API error ${response.status}: ${body}`);
    }

    const data = await response.json() as any;
    const text = data?.content?.[0]?.text;
    if (!text) throw new Error('Anthropic returned no content');
    return text;
  }

  private async callOpenAi(
    config: { model: string; apiKey: string; systemPrompt?: string | null; maxTokens: number },
    messages: { role: 'user' | 'assistant'; content: string }[],
  ): Promise<string> {
    const response = await fetch('https://api.openai.com/v1/chat/completions', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${config.apiKey}`,
      },
      body: JSON.stringify({
        model: config.model || 'gpt-4o-mini',
        max_tokens: config.maxTokens,
        messages: [
          { role: 'system', content: config.systemPrompt || 'You are a helpful assistant.' },
          ...messages,
        ],
      }),
    });

    if (!response.ok) {
      const body = await response.text();
      throw new Error(`OpenAI API error ${response.status}: ${body}`);
    }

    const data = await response.json() as any;
    const text = data?.choices?.[0]?.message?.content;
    if (!text) throw new Error('OpenAI returned no content');
    return text;
  }
}
