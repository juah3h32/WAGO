import { Injectable, Logger, HttpException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import {
  WahaSessionResponse,
  WahaQrCodeResponse,
  WahaChatResponse,
  WahaMeResponse,
  WahaSendTextResponse,
} from './waha.types';

// ─── Evolution API Status → WAHA-compatible status ───────────────────────────
type WahaStatus = 'STOPPED' | 'STARTING' | 'SCAN_QR_CODE' | 'WORKING' | 'FAILED' | 'CONNECTING' | 'PAIRING';

function mapStatus(state: string | undefined): WahaStatus {
  switch ((state ?? '').toLowerCase()) {
    case 'open':
    case 'connected': return 'WORKING';
    case 'qrcode':
    case 'qr': return 'SCAN_QR_CODE';
    case 'connecting': return 'CONNECTING';
    case 'pairing': return 'PAIRING';
    case 'close':
    case 'disconnected':
    case 'closed': return 'STOPPED';
    default: return 'FAILED';
  }
}

@Injectable()
export class WahaService {
  private readonly logger = new Logger(WahaService.name);
  private readonly maxSessions: number;
  private readonly wahaPort: number;

  constructor(private readonly configService: ConfigService) {
    this.maxSessions = Number(this.configService.get('WAHA_MAX_SESSIONS', '1'));
    this.wahaPort = Number(this.configService.get('WAHA_PORT', '8080'));
  }

  resolveSessionName(dbSessionName: string): string {
    return this.maxSessions === 1 ? 'default' : dbSessionName;
  }

  getMaxSessions(): number {
    return this.maxSessions;
  }

  // ─── HTTP helpers ──────────────────────────────────────────────────────────

  private buildUrl(workerUrl: string, path: string): string {
    const base = workerUrl.includes(':') ? workerUrl : `http://${workerUrl}:${this.wahaPort}`;
    return `${base}${path}`;
  }

  private buildHeaders(apiKey: string): Record<string, string> {
    return { 'Content-Type': 'application/json', 'apikey': apiKey };
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
      const options: RequestInit = { method, headers, signal: controller.signal };
      if (body !== undefined) options.body = JSON.stringify(body);

      const response = await fetch(url, options);
      this.logger.log(`Evolution API: ${method} ${url} - Status: ${response.status}`);

      if (!response.ok) {
        const responseBody = await response.text();
        this.logger.error(`Evolution API error: ${method} ${url} returned ${response.status} - ${responseBody}`);
        let wahaMessage = `WAHA API error ${response.status}`;
        try {
          const parsed = JSON.parse(responseBody);
          if (parsed?.message) wahaMessage = Array.isArray(parsed.message) ? parsed.message[0] : parsed.message;
        } catch { /* not JSON */ }
        throw new HttpException(wahaMessage, response.status);
      }

      const text = await response.text();
      if (!text) return undefined as T;
      return JSON.parse(text) as T;
    } catch (error) {
      if (error instanceof Error && error.name === 'AbortError') {
        const msg = `WAHA API timeout: ${method} ${url} exceeded 30s`;
        this.logger.error(msg);
        throw new Error(msg);
      }
      if (error instanceof HttpException) throw error;
      this.logger.error(`WAHA API request failed: ${method} ${url} - ${error instanceof Error ? error.message : String(error)}`);
      throw error;
    } finally {
      clearTimeout(timeout);
    }
  }

  // ─── Session lifecycle ─────────────────────────────────────────────────────

  async resetSession(
    workerUrl: string, apiKey: string, sessionName: string, webhookUrl: string, force = false,
  ): Promise<void> {
    this.logger.log(`Resetting session "${sessionName}" on worker ${workerUrl}${force ? ' (forced)' : ''}`);

    if (!force) {
      try {
        const existing = await this.getSession(workerUrl, apiKey, sessionName);
        const safeStatuses = ['SCAN_QR_CODE', 'WORKING', 'CONNECTING', 'PAIRING'];
        if (existing?.status && safeStatuses.includes(existing.status)) {
          this.logger.log(`Session "${sessionName}" already in ${existing.status}, skipping reset`);
          return;
        }
      } catch { /* no session yet */ }
    }

    try { await this.logoutSession(workerUrl, apiKey, sessionName); } catch { /* ignore */ }
    try { await this.deleteSession(workerUrl, apiKey, sessionName); } catch { /* ignore */ }
    await this.createSession(workerUrl, apiKey, sessionName, webhookUrl);
  }

  async createSession(
    workerUrl: string, apiKey: string, sessionName: string, webhookUrl?: string,
  ): Promise<WahaSessionResponse> {
    const url = this.buildUrl(workerUrl, '/instance/create');
    const headers = this.buildHeaders(apiKey);
    this.logger.log(`Creating session "${sessionName}" on worker ${workerUrl}`);

    const body: any = {
      instanceName: sessionName,
      integration: 'WHATSAPP-BAILEYS',
      qrcode: true,   // triggers QR generation on create
    };

    if (webhookUrl) {
      body.webhook = { enabled: true, url: webhookUrl, events: ['*'] };
    }

    const result = await this.request<any>('POST', url, headers, body);
    // QR will be in result.qrcode.base64 when ready; health/QR poll picks it up
    return this._mapInstance(result?.instance ?? result);
  }

  async startSession(workerUrl: string, apiKey: string, sessionName: string): Promise<void> {
    // For Evolution API, "starting" an existing instance means calling connect
    const headers = this.buildHeaders(apiKey);
    try {
      await this.request<any>('GET', this.buildUrl(workerUrl, `/instance/connect/${sessionName}`), headers);
    } catch { /* QR will come on next poll */ }
  }

  async stopSession(workerUrl: string, apiKey: string, sessionName: string): Promise<void> {
    const headers = this.buildHeaders(apiKey);
    try {
      await this.request<void>('DELETE', this.buildUrl(workerUrl, `/instance/logout/${sessionName}`), headers);
    } catch { /* ignore */ }
  }

  async logoutSession(workerUrl: string, apiKey: string, sessionName: string): Promise<void> {
    const headers = this.buildHeaders(apiKey);
    await this.request<void>('DELETE', this.buildUrl(workerUrl, `/instance/logout/${sessionName}`), headers);
  }

  async deleteSession(workerUrl: string, apiKey: string, sessionName: string): Promise<void> {
    const headers = this.buildHeaders(apiKey);
    await this.request<void>('DELETE', this.buildUrl(workerUrl, `/instance/delete/${sessionName}`), headers);
  }

  async restartSession(workerUrl: string, apiKey: string, sessionName: string): Promise<void> {
    const headers = this.buildHeaders(apiKey);
    await this.request<void>('PUT', this.buildUrl(workerUrl, `/instance/restart/${sessionName}`), headers);
  }

  async getSession(workerUrl: string, apiKey: string, sessionName: string): Promise<WahaSessionResponse> {
    const headers = this.buildHeaders(apiKey);
    const url = this.buildUrl(workerUrl, `/instance/connectionState/${sessionName}`);
    const result = await this.request<any>('GET', url, headers);
    return {
      name: sessionName,
      status: mapStatus(result?.instance?.state ?? result?.state),
    };
  }

  async listSessions(workerUrl: string, apiKey: string): Promise<WahaSessionResponse[]> {
    const headers = this.buildHeaders(apiKey);
    const url = this.buildUrl(workerUrl, '/instance/fetchInstances');
    const result = await this.request<any[]>('GET', url, headers);
    if (!Array.isArray(result)) return [];
    return result.map((inst) => this._mapInstance(inst));
  }

  private _mapInstance(inst: any): WahaSessionResponse {
    // fetchInstances returns { connectionStatus: "open"|"close"|"connecting", name: "..." }
    // connectionState returns { instance: { state: "open"|"close"|... } }
    const state = inst?.instance?.state
      ?? inst?.connectionStatus
      ?? inst?.state
      ?? inst?.status;
    return {
      name: inst?.instance?.instanceName ?? inst?.instanceName ?? inst?.name ?? 'default',
      status: mapStatus(state),
    };
  }

  // ─── QR code ───────────────────────────────────────────────────────────────

  async getQrCode(workerUrl: string, apiKey: string, sessionName: string): Promise<WahaQrCodeResponse> {
    const headers = this.buildHeaders(apiKey);
    const url = this.buildUrl(workerUrl, `/instance/connect/${sessionName}`);
    const result = await this.request<any>('GET', url, headers);

    // Evolution API returns: { base64: "data:image/png;base64,...", code: "2@...", count: 1 }
    // OR on create response: result.qrcode.base64
    const b64: string | undefined = result?.base64 ?? result?.qrcode?.base64 ?? result?.qr;
    if (!b64 || typeof b64 !== 'string') {
      throw new HttpException('QR not ready yet', 503);
    }

    const parts = b64.split(',');
    const mimeMatch = parts[0]?.match(/data:([^;]+)/);
    const mimetype = mimeMatch?.[1] ?? 'image/png';
    const value = parts[1] ?? b64;

    return { value, mimetype };
  }

  // ─── Profile & presence ────────────────────────────────────────────────────

  async getMe(workerUrl: string, apiKey: string, sessionName: string): Promise<WahaMeResponse | null> {
    const headers = this.buildHeaders(apiKey);
    try {
      const result = await this.request<any>(
        'GET',
        this.buildUrl(workerUrl, `/instance/fetchInstances?instanceName=${sessionName}`),
        headers,
      );
      const inst = Array.isArray(result) ? result[0] : result;
      const profileName = inst?.profileName ?? inst?.instance?.profileName ?? null;
      const ownerJid = inst?.ownerJid ?? inst?.instance?.ownerJid ?? null;
      if (!profileName && !ownerJid) return null;
      const id = ownerJid ?? `${sessionName}@s.whatsapp.net`;
      return { id, pushName: profileName ?? sessionName };
    } catch {
      return null;
    }
  }

  async setOnlinePresence(workerUrl: string, apiKey: string, sessionName: string, chatId?: string): Promise<void> {
    if (!chatId) return; // Evolution API requires a recipient for typing presence
    const headers = this.buildHeaders(apiKey);
    try {
      await this.request<void>('POST', this.buildUrl(workerUrl, `/chat/presence/${sessionName}`), headers, {
        number: chatId.replace('@s.whatsapp.net', '').replace('@c.us', ''),
        options: { presence: 'composing', delay: 1000 },
      });
    } catch { /* non-critical */ }
  }

  async setOfflinePresence(workerUrl: string, apiKey: string, sessionName: string, chatId?: string): Promise<void> {
    if (!chatId) return;
    const headers = this.buildHeaders(apiKey);
    try {
      await this.request<void>('POST', this.buildUrl(workerUrl, `/chat/presence/${sessionName}`), headers, {
        number: chatId.replace('@s.whatsapp.net', '').replace('@c.us', ''),
        options: { presence: 'paused', delay: 500 },
      });
    } catch { /* non-critical */ }
  }

  // ─── Chats & messages ──────────────────────────────────────────────────────

  async getChats(workerUrl: string, apiKey: string, sessionName: string): Promise<WahaChatResponse[]> {
    const headers = this.buildHeaders(apiKey);
    const result = await this.request<any>('POST', this.buildUrl(workerUrl, `/chat/findChats/${sessionName}`), headers, {});
    const chats = Array.isArray(result) ? result : (result?.chats ?? []);
    return chats.slice(0, 20).map((c: any) => ({
      id: c.id ?? c.remoteJid ?? '',
      name: c.name ?? c.pushName ?? undefined,
      timestamp: c.updatedAt ? Math.floor(new Date(c.updatedAt).getTime() / 1000) : (c.conversationTimestamp ?? 0),
      lastMessage: c.lastMessage ? {
        body: c.lastMessage.message?.conversation ?? c.lastMessage.message?.extendedTextMessage?.text ?? '',
        timestamp: c.lastMessage.messageTimestamp ?? 0,
        fromMe: c.lastMessage.key?.fromMe ?? false,
      } : undefined,
    }));
  }

  async getMessages(workerUrl: string, apiKey: string, sessionName: string, chatId: string): Promise<any[]> {
    const headers = this.buildHeaders(apiKey);
    try {
      const result = await this.request<any>('POST', this.buildUrl(workerUrl, `/chat/findMessages/${sessionName}`), headers, {
        where: { key: { remoteJid: chatId } },
        limit: 50,
      });
      const msgs = Array.isArray(result) ? result : (result?.messages ?? []);
      return msgs.map((m: any) => ({
        id: m.key?.id ?? m.id,
        fromMe: m.key?.fromMe ?? false,
        body: m.message?.conversation ?? m.message?.extendedTextMessage?.text ?? '',
        timestamp: m.messageTimestamp ?? 0,
      }));
    } catch {
      return [];
    }
  }

  async getProfilePicture(workerUrl: string, apiKey: string, sessionName: string, contactId: string): Promise<{ profilePictureUrl: string | null }> {
    const headers = this.buildHeaders(apiKey);
    try {
      const result = await this.request<any>('POST', this.buildUrl(workerUrl, `/chat/findContacts/${sessionName}`), headers, {
        where: { id: contactId },
      });
      const contact = Array.isArray(result) ? result[0] : result;
      return { profilePictureUrl: contact?.profilePictureUrl ?? null };
    } catch {
      return { profilePictureUrl: null };
    }
  }

  // ─── Messaging ─────────────────────────────────────────────────────────────

  private toNumber(chatId: string): string {
    return chatId.replace('@s.whatsapp.net', '').replace('@c.us', '').replace('@g.us', '');
  }

  async sendText(
    workerUrl: string, apiKey: string, sessionName: string,
    chatId: string, text: string,
    options?: { skipPresence?: boolean; replyTo?: string; extraDelayMs?: number },
  ): Promise<WahaSendTextResponse> {
    if (!options?.skipPresence) await this.simulatePresence(workerUrl, apiKey, sessionName, chatId, text.length, options?.extraDelayMs ?? 0);
    const headers = this.buildHeaders(apiKey);
    const body: any = { number: this.toNumber(chatId), text };
    if (options?.replyTo) body.options = { quoted: { key: { id: options.replyTo } } };
    const result = await this.request<any>('POST', this.buildUrl(workerUrl, `/message/sendText/${sessionName}`), headers, body);
    if (!options?.skipPresence) setTimeout(() => this.setOfflinePresence(workerUrl, apiKey, sessionName, chatId).catch(() => {}), 2_000 + Math.random() * 2_000);
    return { id: result?.key?.id ?? '', timestamp: result?.messageTimestamp ?? 0 };
  }

  async sendImage(
    workerUrl: string, apiKey: string, sessionName: string,
    chatId: string, mediaUrl?: string, caption?: string,
    mediaData?: string, mimetype?: string,
    options?: { skipPresence?: boolean; extraDelayMs?: number },
  ): Promise<any> {
    if (!options?.skipPresence) await this.simulatePresence(workerUrl, apiKey, sessionName, chatId, caption?.length ?? 20, options?.extraDelayMs ?? 0);
    const headers = this.buildHeaders(apiKey);
    const media = mediaData ? `data:${mimetype ?? 'image/jpeg'};base64,${mediaData}` : mediaUrl;
    const result = await this.request<any>('POST', this.buildUrl(workerUrl, `/message/sendMedia/${sessionName}`), headers, {
      number: this.toNumber(chatId),
      mediatype: 'image',
      media,
      caption,
    });
    if (!options?.skipPresence) setTimeout(() => this.setOfflinePresence(workerUrl, apiKey, sessionName, chatId).catch(() => {}), 2_000 + Math.random() * 2_000);
    return result;
  }

  async sendFile(
    workerUrl: string, apiKey: string, sessionName: string,
    chatId: string, mediaUrl?: string, filename?: string,
    caption?: string, mediaData?: string, mimetype?: string,
    options?: { skipPresence?: boolean; extraDelayMs?: number },
  ): Promise<any> {
    if (!options?.skipPresence) await this.simulatePresence(workerUrl, apiKey, sessionName, chatId, caption?.length ?? 20, options?.extraDelayMs ?? 0);
    const headers = this.buildHeaders(apiKey);
    const media = mediaData ? `data:${mimetype ?? 'application/octet-stream'};base64,${mediaData}` : mediaUrl;
    const result = await this.request<any>('POST', this.buildUrl(workerUrl, `/message/sendMedia/${sessionName}`), headers, {
      number: this.toNumber(chatId),
      mediatype: 'document',
      media,
      caption,
      fileName: filename,
    });
    if (!options?.skipPresence) setTimeout(() => this.setOfflinePresence(workerUrl, apiKey, sessionName, chatId).catch(() => {}), 2_000 + Math.random() * 2_000);
    return result;
  }

  async sendVideo(
    workerUrl: string, apiKey: string, sessionName: string,
    chatId: string, mediaUrl?: string, caption?: string,
    mediaData?: string, mimetype?: string,
    options?: { skipPresence?: boolean; extraDelayMs?: number },
  ): Promise<any> {
    if (!options?.skipPresence) await this.simulatePresence(workerUrl, apiKey, sessionName, chatId, caption?.length ?? 20, options?.extraDelayMs ?? 0);
    const headers = this.buildHeaders(apiKey);
    const media = mediaData ? `data:${mimetype ?? 'video/mp4'};base64,${mediaData}` : mediaUrl;
    const result = await this.request<any>('POST', this.buildUrl(workerUrl, `/message/sendMedia/${sessionName}`), headers, {
      number: this.toNumber(chatId),
      mediatype: 'video',
      media,
      caption,
    });
    if (!options?.skipPresence) setTimeout(() => this.setOfflinePresence(workerUrl, apiKey, sessionName, chatId).catch(() => {}), 2_000 + Math.random() * 2_000);
    return result;
  }

  async sendVoice(
    workerUrl: string, apiKey: string, sessionName: string,
    chatId: string, mediaUrl?: string, mediaData?: string, mimetype?: string,
    options?: { skipPresence?: boolean; extraDelayMs?: number },
  ): Promise<any> {
    if (!options?.skipPresence) await this.simulatePresence(workerUrl, apiKey, sessionName, chatId, 20, options?.extraDelayMs ?? 0);
    const headers = this.buildHeaders(apiKey);
    const media = mediaData ? `data:${mimetype ?? 'audio/ogg'};base64,${mediaData}` : mediaUrl;
    const result = await this.request<any>('POST', this.buildUrl(workerUrl, `/message/sendWhatsAppAudio/${sessionName}`), headers, {
      number: this.toNumber(chatId),
      audio: media,
      encoding: true,
    });
    if (!options?.skipPresence) setTimeout(() => this.setOfflinePresence(workerUrl, apiKey, sessionName, chatId).catch(() => {}), 2_000 + Math.random() * 2_000);
    return result;
  }

  async sendLocation(
    workerUrl: string, apiKey: string, sessionName: string,
    chatId: string, lat: number, lng: number, name?: string, address?: string,
    options?: { skipPresence?: boolean; extraDelayMs?: number },
  ): Promise<any> {
    if (!options?.skipPresence) await this.simulatePresence(workerUrl, apiKey, sessionName, chatId, 10, options?.extraDelayMs ?? 0);
    const headers = this.buildHeaders(apiKey);
    const result = await this.request<any>('POST', this.buildUrl(workerUrl, `/message/sendLocation/${sessionName}`), headers, {
      number: this.toNumber(chatId),
      name: name ?? '',
      address: address ?? '',
      latitude: lat,
      longitude: lng,
    });
    if (!options?.skipPresence) setTimeout(() => this.setOfflinePresence(workerUrl, apiKey, sessionName, chatId).catch(() => {}), 2_000 + Math.random() * 2_000);
    return result;
  }

  async sendContactVcard(
    workerUrl: string, apiKey: string, sessionName: string,
    chatId: string, contactId: string, contactName: string,
    options?: { skipPresence?: boolean; extraDelayMs?: number },
  ): Promise<any> {
    if (!options?.skipPresence) await this.simulatePresence(workerUrl, apiKey, sessionName, chatId, 15, options?.extraDelayMs ?? 0);
    const headers = this.buildHeaders(apiKey);
    const result = await this.request<any>('POST', this.buildUrl(workerUrl, `/message/sendContact/${sessionName}`), headers, {
      number: this.toNumber(chatId),
      contact: [{ fullName: contactName, wuid: this.toNumber(contactId), phoneNumber: this.toNumber(contactId) }],
    });
    if (!options?.skipPresence) setTimeout(() => this.setOfflinePresence(workerUrl, apiKey, sessionName, chatId).catch(() => {}), 2_000 + Math.random() * 2_000);
    return result;
  }

  async sendReaction(
    workerUrl: string, apiKey: string, sessionName: string,
    chatId: string, messageId: string, reaction: string,
  ): Promise<any> {
    const headers = this.buildHeaders(apiKey);
    return this.request<any>('POST', this.buildUrl(workerUrl, `/message/sendReaction/${sessionName}`), headers, {
      key: { remoteJid: chatId, id: messageId },
      reaction,
    });
  }

  // ─── Typing & seen ─────────────────────────────────────────────────────────

  async sendSeen(workerUrl: string, apiKey: string, sessionName: string, chatId: string): Promise<void> {
    const headers = this.buildHeaders(apiKey);
    try {
      await this.request<void>('POST', this.buildUrl(workerUrl, `/chat/markMessageAsRead/${sessionName}`), headers, {
        readMessages: [{ remoteJid: chatId, fromMe: false, id: 'last' }],
      });
    } catch { /* non-critical */ }
  }

  async startTyping(workerUrl: string, apiKey: string, sessionName: string, chatId: string): Promise<void> {
    const headers = this.buildHeaders(apiKey);
    try {
      await this.request<void>('POST', this.buildUrl(workerUrl, `/chat/presence/${sessionName}`), headers, {
        number: this.toNumber(chatId),
        options: { presence: 'composing', delay: 4000 },
      });
    } catch { /* non-critical */ }
  }

  async stopTyping(workerUrl: string, apiKey: string, sessionName: string, chatId: string): Promise<void> {
    const headers = this.buildHeaders(apiKey);
    try {
      await this.request<void>('POST', this.buildUrl(workerUrl, `/chat/presence/${sessionName}`), headers, {
        number: this.toNumber(chatId),
        options: { presence: 'paused', delay: 500 },
      });
    } catch { /* non-critical */ }
  }

  // ─── Human-like presence simulation ───────────────────────────────────────

  humanDelay(messageLength: number): number {
    const base = 800 + Math.random() * 1_400;
    const typingRate = 30 + Math.random() * 30;
    const typing = Math.min(messageLength * typingRate, 4_000);
    const thinkingPause = Math.random() < 0.2 ? 1_000 + Math.random() * 2_000 : 0;
    return Math.round(base + typing + thinkingPause);
  }

  async simulatePresence(
    workerUrl: string, apiKey: string, sessionName: string,
    chatId: string, contentLength = 20, extraDelayMs = 0,
  ): Promise<void> {
    try { await this.setOnlinePresence(workerUrl, apiKey, sessionName, chatId); } catch { /* non-critical */ }
    try { await this.sendSeen(workerUrl, apiKey, sessionName, chatId); } catch { /* non-critical */ }
    await new Promise((r) => setTimeout(r, 500 + Math.random() * 1_500));
    try { await this.startTyping(workerUrl, apiKey, sessionName, chatId); } catch { /* non-critical */ }
    const typingRate = 30 + Math.random() * 30;
    const typingDelay = Math.min(contentLength * typingRate, 6_000);
    await new Promise((r) => setTimeout(r, typingDelay + extraDelayMs));
    try { await this.stopTyping(workerUrl, apiKey, sessionName, chatId); } catch { /* non-critical */ }
    await new Promise((r) => setTimeout(r, 200 + Math.random() * 300));
  }
}
