import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import {
  WahaSessionResponse,
  WahaQrCodeResponse,
  WahaChatResponse,
  WahaMeResponse,
  WahaSendTextResponse,
} from './waha.types';

@Injectable()
export class WahaService {
  private readonly logger = new Logger(WahaService.name);
  private readonly maxSessions: number;

  private readonly wahaPort: number;

  constructor(private readonly configService: ConfigService) {
    this.maxSessions = Number(
      this.configService.get('WAHA_MAX_SESSIONS', '1'),
    );
    this.wahaPort = Number(this.configService.get('WAHA_PORT', '3000'));
  }

  /**
   * Resolve the WAHA session name. WAHA Core only supports 'default'.
   * WAHA Plus supports custom session names.
   */
  resolveSessionName(dbSessionName: string): string {
    return this.maxSessions === 1 ? 'default' : dbSessionName;
  }

  /**
   * Fully reset a WAHA session: stop → logout → delete → recreate with config.
   * This ensures webhook URL and NOWEB store config are always preserved.
   */
  async resetSession(
    workerUrl: string,
    apiKey: string,
    sessionName: string,
    webhookUrl: string,
  ): Promise<void> {
    this.logger.log(
      `Resetting session "${sessionName}" on worker ${workerUrl}`,
    );
    // If WAHA already has the session ready to scan, skip the destructive reset
    try {
      const existing = await this.getSession(workerUrl, apiKey, sessionName);
      if (existing?.status === 'SCAN_QR_CODE' || existing?.status === 'WORKING') {
        this.logger.log(`Session "${sessionName}" already in ${existing.status}, skipping reset`);
        return;
      }
    } catch {
      // No session exists yet — proceed with full reset below
    }
    try {
      await this.stopSession(workerUrl, apiKey, sessionName);
    } catch {
      // Ignore — may already be stopped
    }
    try {
      await this.logoutSession(workerUrl, apiKey, sessionName);
    } catch {
      // Ignore — clears auth state
    }
    try {
      await this.deleteSession(workerUrl, apiKey, sessionName);
    } catch {
      // Ignore — may not exist
    }
    // start:true in createSession starts it automatically
    await this.createSession(workerUrl, apiKey, sessionName, webhookUrl);
  }

  getMaxSessions(): number {
    return this.maxSessions;
  }

  private buildUrl(workerUrl: string, path: string): string {
    // If workerUrl already has a protocol, don't prepend 'http://' and don't append port if it's already there
    if (workerUrl.startsWith('http://') || workerUrl.startsWith('https://')) {
      const baseUrl = workerUrl.endsWith('/') ? workerUrl.slice(0, -1) : workerUrl;
      return `${baseUrl}${path}`;
    }
    return `http://${workerUrl}:${this.wahaPort}${path}`;
  }

  private buildHeaders(apiKey: string): Record<string, string> {
    return {
      'X-Api-Key': apiKey,
      'Content-Type': 'application/json',
    };
  }

  private async request<T>(
    method: string,
    url: string,
    headers: Record<string, string>,
    body?: unknown,
  ): Promise<T> {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 30_000);

    try {
      const options: RequestInit = {
        method,
        headers,
        signal: controller.signal,
      };

      if (body !== undefined) {
        options.body = JSON.stringify(body);
      }

      const response = await fetch(url, options);
      this.logger.log(`WAHA API: ${method} ${url} - Status: ${response.status}`);

      if (!response.ok) {
        const responseBody = await response.text();
        const message = `WAHA API error: ${method} ${url} returned ${response.status} - ${responseBody}`;
        this.logger.error(message);
        throw new Error(message);
      }

      const text = await response.text();
      if (!text) {
        return undefined as T;
      }

      return JSON.parse(text) as T;
    } catch (error) {
      if (error instanceof Error && error.name === 'AbortError') {
        const message = `WAHA API timeout: ${method} ${url} exceeded 30s`;
        this.logger.error(message);
        throw new Error(message);
      }

      if (error instanceof Error && error.message.startsWith('WAHA API')) {
        throw error;
      }

      this.logger.error(
        `WAHA API request failed: ${method} ${url} - ${error instanceof Error ? error.message : String(error)}`,
      );
      throw error;
    } finally {
      clearTimeout(timeout);
    }
  }

  async createSession(
    workerUrl: string,
    apiKey: string,
    sessionName: string,
    webhookUrl?: string,
  ): Promise<WahaSessionResponse> {
    const url = this.buildUrl(workerUrl, '/api/sessions');
    const headers = this.buildHeaders(apiKey);

    this.logger.log(`Creating session "${sessionName}" on worker ${workerUrl}`);

    return this.request<WahaSessionResponse>('POST', url, headers, {
      name: sessionName,
      start: true,
      config: {
        noweb: {
          store: {
            enabled: true,
            fullSync: true,
          },
        },
        webhooks: webhookUrl
          ? [
              {
                url: webhookUrl,
                events: ['*'],
              },
            ]
          : [],
      },
    });
  }

  async startSession(
    workerUrl: string,
    apiKey: string,
    sessionName: string,
  ): Promise<void> {
    const url = this.buildUrl(
      workerUrl,
      `/api/sessions/${encodeURIComponent(sessionName)}/start`,
    );
    const headers = this.buildHeaders(apiKey);

    this.logger.log(`Starting session "${sessionName}" on worker ${workerUrl}`);

    await this.request<void>('POST', url, headers);
  }

  async stopSession(
    workerUrl: string,
    apiKey: string,
    sessionName: string,
  ): Promise<void> {
    const url = this.buildUrl(
      workerUrl,
      `/api/sessions/${encodeURIComponent(sessionName)}/stop`,
    );
    const headers = this.buildHeaders(apiKey);

    this.logger.log(`Stopping session "${sessionName}" on worker ${workerUrl}`);

    await this.request<void>('POST', url, headers);
  }

  async deleteSession(
    workerUrl: string,
    apiKey: string,
    sessionName: string,
  ): Promise<void> {
    const url = this.buildUrl(
      workerUrl,
      `/api/sessions/${encodeURIComponent(sessionName)}`,
    );
    const headers = this.buildHeaders(apiKey);

    this.logger.log(
      `Deleting session "${sessionName}" on worker ${workerUrl}`,
    );

    await this.request<void>('DELETE', url, headers);
  }

  async getSession(
    workerUrl: string,
    apiKey: string,
    sessionName: string,
  ): Promise<WahaSessionResponse> {
    const url = this.buildUrl(
      workerUrl,
      `/api/sessions/${encodeURIComponent(sessionName)}`,
    );
    const headers = this.buildHeaders(apiKey);

    this.logger.log(
      `Getting session "${sessionName}" from worker ${workerUrl}`,
    );

    return this.request<WahaSessionResponse>('GET', url, headers);
  }

  async listSessions(
    workerUrl: string,
    apiKey: string,
  ): Promise<WahaSessionResponse[]> {
    const url = this.buildUrl(workerUrl, '/api/sessions?all=true');
    const headers = this.buildHeaders(apiKey);

    this.logger.log(`Listing sessions on worker ${workerUrl}`);

    return this.request<WahaSessionResponse[]>('GET', url, headers);
  }

  async getQrCode(
    workerUrl: string,
    apiKey: string,
    sessionName: string,
  ): Promise<WahaQrCodeResponse> {
    const url = this.buildUrl(
      workerUrl,
      `/api/${encodeURIComponent(sessionName)}/auth/qr`,
    );
    const headers = this.buildHeaders(apiKey);

    this.logger.log(
      `Getting QR code for session "${sessionName}" on worker ${workerUrl}`,
    );

    // QR endpoint returns raw PNG by default, not JSON
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 30_000);

    try {
      const response = await fetch(url, {
        method: 'GET',
        headers,
        signal: controller.signal,
      });
      this.logger.log(`WAHA API (QR): GET ${url} - Status: ${response.status}`);

      if (!response.ok) {
        const body = await response.text();
        const message = `WAHA API error: GET ${url} returned ${response.status} - ${body}`;
        this.logger.error(message);
        throw new Error(message);
      }

      const buffer = Buffer.from(await response.arrayBuffer());
      const base64 = buffer.toString('base64');

      return {
        value: base64,
        mimetype: response.headers.get('content-type') || 'image/png',
      };
    } finally {
      clearTimeout(timeout);
    }
  }

  async restartSession(
    workerUrl: string,
    apiKey: string,
    sessionName: string,
  ): Promise<void> {
    const url = this.buildUrl(
      workerUrl,
      `/api/sessions/${encodeURIComponent(sessionName)}/restart`,
    );
    const headers = this.buildHeaders(apiKey);

    this.logger.log(
      `Restarting session "${sessionName}" on worker ${workerUrl}`,
    );

    await this.request<void>('POST', url, headers);
  }

  async getChats(
    workerUrl: string,
    apiKey: string,
    sessionName: string,
  ): Promise<WahaChatResponse[]> {
    const url = this.buildUrl(
      workerUrl,
      `/api/${encodeURIComponent(sessionName)}/chats?limit=20&sortBy=conversationTimestamp&sortOrder=desc`,
    );
    const headers = this.buildHeaders(apiKey);

    return this.request<WahaChatResponse[]>('GET', url, headers);
  }

  async getProfilePicture(
    workerUrl: string,
    apiKey: string,
    sessionName: string,
    contactId: string,
  ): Promise<{ profilePictureUrl: string | null }> {
    const url = this.buildUrl(
      workerUrl,
      `/api/contacts/profile-picture?contactId=${encodeURIComponent(contactId)}&session=${encodeURIComponent(sessionName)}`,
    );
    const headers = this.buildHeaders(apiKey);

    try {
      const result = await this.request<{ profilePictureURL: string | null }>('GET', url, headers);
      return { profilePictureUrl: result.profilePictureURL };
    } catch {
      return { profilePictureUrl: null };
    }
  }

  private buildFilePayload(opts: { mediaUrl?: string; mediaData?: string; mimetype?: string; filename?: string }): any {
    if (opts.mediaData) {
      const file: any = { data: opts.mediaData };
      if (opts.mimetype) file.mimetype = opts.mimetype;
      if (opts.filename) file.filename = opts.filename;
      return file;
    }
    const file: any = { url: opts.mediaUrl };
    if (opts.filename) file.filename = opts.filename;
    return file;
  }

  async sendImage(
    workerUrl: string,
    apiKey: string,
    sessionName: string,
    chatId: string,
    mediaUrl?: string,
    caption?: string,
    mediaData?: string,
    mimetype?: string,
    options?: { skipPresence?: boolean; extraDelayMs?: number },
  ): Promise<any> {
    if (!options?.skipPresence) {
      // Media sends use a shorter content length (caption length or 20)
      const len = caption?.length ?? 20;
      await this.simulatePresence(workerUrl, apiKey, sessionName, chatId, len, options?.extraDelayMs ?? 0);
    }
    const url = this.buildUrl(workerUrl, '/api/sendImage');
    const headers = this.buildHeaders(apiKey);
    const body: any = { chatId, session: sessionName, file: this.buildFilePayload({ mediaUrl, mediaData, mimetype }) };
    if (caption) body.caption = caption;

    const result = await this.request<any>('POST', url, headers, body);
    if (!options?.skipPresence) {
      const d = 1_500 + Math.random() * 3_000;
      setTimeout(() => { this.setOfflinePresence(workerUrl, apiKey, sessionName).catch(() => {}); }, d);
    }
    return result;
  }

  async sendFile(
    workerUrl: string,
    apiKey: string,
    sessionName: string,
    chatId: string,
    mediaUrl?: string,
    filename?: string,
    caption?: string,
    mediaData?: string,
    mimetype?: string,
    options?: { skipPresence?: boolean; extraDelayMs?: number },
  ): Promise<any> {
    if (!options?.skipPresence) {
      const len = caption?.length ?? 20;
      await this.simulatePresence(workerUrl, apiKey, sessionName, chatId, len, options?.extraDelayMs ?? 0);
    }
    const url = this.buildUrl(workerUrl, '/api/sendFile');
    const headers = this.buildHeaders(apiKey);
    const body: any = { chatId, session: sessionName, file: this.buildFilePayload({ mediaUrl, mediaData, mimetype, filename }) };
    if (caption) body.caption = caption;

    const result = await this.request<any>('POST', url, headers, body);
    if (!options?.skipPresence) {
      const d = 1_500 + Math.random() * 3_000;
      setTimeout(() => { this.setOfflinePresence(workerUrl, apiKey, sessionName).catch(() => {}); }, d);
    }
    return result;
  }

  async sendVoice(
    workerUrl: string,
    apiKey: string,
    sessionName: string,
    chatId: string,
    mediaUrl?: string,
    mediaData?: string,
    mimetype?: string,
    options?: { skipPresence?: boolean; extraDelayMs?: number },
  ): Promise<any> {
    if (!options?.skipPresence) {
      await this.simulatePresence(workerUrl, apiKey, sessionName, chatId, 20, options?.extraDelayMs ?? 0);
    }
    const url = this.buildUrl(workerUrl, '/api/sendVoice');
    const headers = this.buildHeaders(apiKey);

    const result = await this.request<any>('POST', url, headers, {
      chatId,
      session: sessionName,
      file: this.buildFilePayload({ mediaUrl, mediaData, mimetype }),
    });
    if (!options?.skipPresence) {
      const d = 1_500 + Math.random() * 3_000;
      setTimeout(() => { this.setOfflinePresence(workerUrl, apiKey, sessionName).catch(() => {}); }, d);
    }
    return result;
  }

  async sendVideo(
    workerUrl: string,
    apiKey: string,
    sessionName: string,
    chatId: string,
    mediaUrl?: string,
    caption?: string,
    mediaData?: string,
    mimetype?: string,
    options?: { skipPresence?: boolean; extraDelayMs?: number },
  ): Promise<any> {
    if (!options?.skipPresence) {
      const len = caption?.length ?? 20;
      await this.simulatePresence(workerUrl, apiKey, sessionName, chatId, len, options?.extraDelayMs ?? 0);
    }
    const url = this.buildUrl(workerUrl, '/api/sendVideo');
    const headers = this.buildHeaders(apiKey);
    const body: any = { chatId, session: sessionName, file: this.buildFilePayload({ mediaUrl, mediaData, mimetype }) };
    if (caption) body.caption = caption;

    const result = await this.request<any>('POST', url, headers, body);
    if (!options?.skipPresence) {
      const d = 1_500 + Math.random() * 3_000;
      setTimeout(() => { this.setOfflinePresence(workerUrl, apiKey, sessionName).catch(() => {}); }, d);
    }
    return result;
  }

  async sendLocation(
    workerUrl: string,
    apiKey: string,
    sessionName: string,
    chatId: string,
    latitude: number,
    longitude: number,
    name?: string,
    address?: string,
    options?: { skipPresence?: boolean; extraDelayMs?: number },
  ): Promise<any> {
    if (!options?.skipPresence) {
      await this.simulatePresence(workerUrl, apiKey, sessionName, chatId, 20, options?.extraDelayMs ?? 0);
    }
    const url = this.buildUrl(workerUrl, '/api/sendLocation');
    const headers = this.buildHeaders(apiKey);

    const result = await this.request<any>('POST', url, headers, {
      chatId,
      session: sessionName,
      latitude,
      longitude,
      title: name,
      address,
    });
    if (!options?.skipPresence) {
      const d = 1_500 + Math.random() * 3_000;
      setTimeout(() => { this.setOfflinePresence(workerUrl, apiKey, sessionName).catch(() => {}); }, d);
    }
    return result;
  }

  async sendContactVcard(
    workerUrl: string,
    apiKey: string,
    sessionName: string,
    chatId: string,
    contactName: string,
    contactPhone: string,
    options?: { skipPresence?: boolean; extraDelayMs?: number },
  ): Promise<any> {
    if (!options?.skipPresence) {
      await this.simulatePresence(workerUrl, apiKey, sessionName, chatId, 20, options?.extraDelayMs ?? 0);
    }
    const url = this.buildUrl(workerUrl, '/api/sendContactVcard');
    const headers = this.buildHeaders(apiKey);
    const vcard = [
      'BEGIN:VCARD',
      'VERSION:3.0',
      `FN:${contactName}`,
      `TEL;type=CELL;type=VOICE;waid=${contactPhone.replace(/\D/g, '')}:+${contactPhone.replace(/\D/g, '')}`,
      'END:VCARD',
    ].join('\n');

    const result = await this.request<any>('POST', url, headers, {
      chatId,
      session: sessionName,
      contacts: [{ vcard }],
    });
    if (!options?.skipPresence) {
      const d = 1_500 + Math.random() * 3_000;
      setTimeout(() => { this.setOfflinePresence(workerUrl, apiKey, sessionName).catch(() => {}); }, d);
    }
    return result;
  }

  async getMessages(
    workerUrl: string,
    apiKey: string,
    sessionName: string,
    chatId: string,
    limit: number = 50,
  ): Promise<any[]> {
    const url = this.buildUrl(
      workerUrl,
      `/api/${encodeURIComponent(sessionName)}/chats/${encodeURIComponent(chatId)}/messages?limit=${limit}&downloadMedia=false`,
    );
    const headers = this.buildHeaders(apiKey);

    return this.request<any[]>('GET', url, headers);
  }

  async getMe(
    workerUrl: string,
    apiKey: string,
    sessionName: string,
  ): Promise<WahaMeResponse> {
    const url = this.buildUrl(
      workerUrl,
      `/api/sessions/${encodeURIComponent(sessionName)}/me`,
    );
    const headers = this.buildHeaders(apiKey);

    return this.request<WahaMeResponse>('GET', url, headers);
  }

  async sendSeen(
    workerUrl: string,
    apiKey: string,
    sessionName: string,
    chatId: string,
  ): Promise<void> {
    const url = this.buildUrl(workerUrl, '/api/sendSeen');
    const headers = this.buildHeaders(apiKey);

    await this.request<void>('POST', url, headers, {
      chatId,
      session: sessionName,
    });
  }

  async startTyping(
    workerUrl: string,
    apiKey: string,
    sessionName: string,
    chatId: string,
  ): Promise<void> {
    const url = this.buildUrl(workerUrl, '/api/startTyping');
    const headers = this.buildHeaders(apiKey);

    await this.request<void>('POST', url, headers, {
      chatId,
      session: sessionName,
    });
  }

  async stopTyping(
    workerUrl: string,
    apiKey: string,
    sessionName: string,
    chatId: string,
  ): Promise<void> {
    const url = this.buildUrl(workerUrl, '/api/stopTyping');
    const headers = this.buildHeaders(apiKey);

    await this.request<void>('POST', url, headers, {
      chatId,
      session: sessionName,
    });
  }

  /**
   * Full human-like presence sequence before sending:
   *   1. Set online presence (so the contact sees "online" in WA)
   *   2. Mark chat as seen (removes unread badge — humans read before replying)
   *   3. Pause briefly to simulate reading time (0.5–2 s)
   *   4. Start typing indicator
   *   5. Wait a random delay based on content length (30–60 ms/char, capped 6 s)
   *      plus an occasional "thinking" pause
   *   6. Stop typing
   *   7. Set offline/unavailable presence (go "offline" after the message is sent)
   *
   * WHY each step matters:
   * - Step 1: Without an online signal, WA logs show the account sending messages
   *   while "last seen" never updates — a known bot pattern.
   * - Step 2: Marking seen before replying matches human behavior. Bots that never
   *   read messages (double-tick never turns blue) are flagged.
   * - Step 4–6: The typing indicator occupies real time in the recipient's UI.
   *   Its duration should match the actual message length. A fixed 1 s typing delay
   *   for all message sizes is trivially detected.
   * - Step 7: Staying "online" continuously (never going offline) is a bot signal.
   *
   * @param extraDelayMs - Additional ms to wait (from AntiSpamService.humanDelay)
   */
  async simulatePresence(
    workerUrl: string,
    apiKey: string,
    sessionName: string,
    chatId: string,
    contentLength = 20,
    extraDelayMs = 0,
  ): Promise<void> {
    // Step 1: Set online presence
    try { await this.setOnlinePresence(workerUrl, apiKey, sessionName); } catch { /* non-critical */ }

    // Step 2: Mark chat as seen
    try { await this.sendSeen(workerUrl, apiKey, sessionName, chatId); } catch { /* non-critical */ }

    // Step 3: Brief read pause (500–2000 ms)
    const readPause = 500 + Math.random() * 1_500;
    await new Promise((resolve) => setTimeout(resolve, readPause));

    // Step 4: Start typing
    try { await this.startTyping(workerUrl, apiKey, sessionName, chatId); } catch { /* non-critical */ }

    // Step 5: Typing duration — 30–60 ms/char, capped at 6 s, plus extra delay from AntiSpamService
    const typingRate = 30 + Math.random() * 30;
    const typingDelay = Math.min(contentLength * typingRate, 6_000);
    const totalWait = typingDelay + extraDelayMs;
    await new Promise((resolve) => setTimeout(resolve, totalWait));

    // Step 6: Stop typing
    try { await this.stopTyping(workerUrl, apiKey, sessionName, chatId); } catch { /* non-critical */ }

    // Step 7: Brief gap between stop-typing and actual send (makes it feel natural)
    await new Promise((resolve) => setTimeout(resolve, 200 + Math.random() * 300));
  }

  /**
   * Set presence to ONLINE for a session.
   * WAHA NOWEB engine supports POST /api/{session}/presence with { presence: "available" }
   */
  async setOnlinePresence(
    workerUrl: string,
    apiKey: string,
    sessionName: string,
  ): Promise<void> {
    const url = this.buildUrl(
      workerUrl,
      `/api/${encodeURIComponent(sessionName)}/presence`,
    );
    const headers = this.buildHeaders(apiKey);
    await this.request<void>('POST', url, headers, { presence: 'available' });
  }

  /**
   * Set presence to OFFLINE/UNAVAILABLE for a session.
   * Call this after sending to avoid the number appearing "always online".
   */
  async setOfflinePresence(
    workerUrl: string,
    apiKey: string,
    sessionName: string,
  ): Promise<void> {
    const url = this.buildUrl(
      workerUrl,
      `/api/${encodeURIComponent(sessionName)}/presence`,
    );
    const headers = this.buildHeaders(apiKey);
    await this.request<void>('POST', url, headers, { presence: 'unavailable' });
  }

  async sendText(
    workerUrl: string,
    apiKey: string,
    sessionName: string,
    chatId: string,
    text: string,
    options?: { skipPresence?: boolean; replyTo?: string; extraDelayMs?: number },
  ): Promise<WahaSendTextResponse> {
    this.logger.log(
      `Sending text to ${chatId} via session "${sessionName}" on worker ${workerUrl}`,
    );

    if (!options?.skipPresence) {
      await this.simulatePresence(
        workerUrl, apiKey, sessionName, chatId,
        text.length, options?.extraDelayMs ?? 0,
      );
    }

    const url = this.buildUrl(workerUrl, '/api/sendText');
    const headers = this.buildHeaders(apiKey);
    const body: any = { chatId, text, session: sessionName };
    if (options?.replyTo) body.reply_to = options.replyTo;

    const result = await this.request<WahaSendTextResponse>('POST', url, headers, body);

    // Go offline after sending — staying "always online" is a bot signal
    if (!options?.skipPresence) {
      const offlineDelay = 1_500 + Math.random() * 3_000; // 1.5–4.5 s after send
      setTimeout(() => {
        this.setOfflinePresence(workerUrl, apiKey, sessionName).catch(() => {
          // Non-critical, fire-and-forget
        });
      }, offlineDelay);
    }

    return result;
  }

  async sendReaction(
    workerUrl: string,
    apiKey: string,
    sessionName: string,
    chatId: string,
    messageId: string,
    reaction: string,
  ): Promise<void> {
    const url = this.buildUrl(workerUrl, '/api/reaction');
    const headers = this.buildHeaders(apiKey);

    await this.request<void>('PUT', url, headers, {
      messageId,
      reaction,
      session: sessionName,
    });
  }

  async logoutSession(
    workerUrl: string,
    apiKey: string,
    sessionName: string,
  ): Promise<void> {
    const url = this.buildUrl(
      workerUrl,
      `/api/sessions/${encodeURIComponent(sessionName)}/logout`,
    );
    const headers = this.buildHeaders(apiKey);

    this.logger.log(
      `Logging out session "${sessionName}" on worker ${workerUrl}`,
    );

    await this.request<void>('POST', url, headers);
  }
}
