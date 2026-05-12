import {
  Controller,
  Get,
  Post,
  Patch,
  Delete,
  Param,
  Body,
  Inject,
  UseGuards,
  Logger,
  NotFoundException,
  ForbiddenException,
  ServiceUnavailableException,
  Header,
  StreamableFile,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { eq, and, ne, inArray, desc } from 'drizzle-orm';
import { randomBytes } from 'crypto';
import { wahaSessions } from '@wago/db';
import { AuthGuard } from '../auth/auth.guard';
import { CurrentUser } from '../auth/user.decorator';
import { DRIZZLE_TOKEN } from '../database/database.module';
import { WorkersService } from '../workers/workers.service';
import { WahaService } from '../waha/waha.service';
import { AntiSpamService } from '../waha/anti-spam.service';

@Controller('connections')
@UseGuards(AuthGuard)
export class ConnectionsController {
  private readonly logger = new Logger(ConnectionsController.name);

  constructor(
    @Inject(DRIZZLE_TOKEN) private readonly db: any,
    private readonly workersService: WorkersService,
    private readonly wahaService: WahaService,
    private readonly antiSpamService: AntiSpamService,
    private readonly configService: ConfigService,
  ) {}

  /** Map internal status names to user-friendly ones */
  private mapStatus(status: string): string {
    if (status === 'working') return 'connected';
    return status;
  }

  private mapConnection(conn: any): any {
    return { ...conn, status: this.mapStatus(conn.status) };
  }

  @Get()
  async listConnections(@CurrentUser() user: { sub: string }) {
    const results = await this.db
      .select()
      .from(wahaSessions)
      .where(
        and(
          eq(wahaSessions.userId, user.sub),
          ne(wahaSessions.status, 'stopped'),
        ),
      );

    return results.map((c: any) => this.mapConnection(c));
  }

  /**
   * Get a connection ready to scan, reusing an idle one if available.
   * Returns { id, status, qr } — one call, one response.
   */
  @Post('get-or-create')
  async getOrCreateScannable(@CurrentUser() user: { sub: string }) {
    // 1. Look for an existing idle connection (scan_qr, pending, or failed)
    const idleStatuses: ('scan_qr' | 'pending' | 'failed')[] = ['scan_qr', 'pending', 'failed'];
    const [idle] = await this.db
      .select()
      .from(wahaSessions)
      .where(
        and(
          eq(wahaSessions.userId, user.sub),
          inArray(wahaSessions.status, idleStatuses),
        ),
      )
      .orderBy(desc(wahaSessions.createdAt))
      .limit(1);

    let connectionId: string;

    if (idle) {
      // 2a. Reuse existing — restart it
      this.logger.log(`Reusing idle connection ${idle.id} (status: ${idle.status})`);
      connectionId = idle.id;

      const worker = await this.workersService.getWorkerForSession(idle.id);
      if (worker) {
        const wahaName = this.wahaService.resolveSessionName(idle.sessionName);
        const apiUrl = this.configService.get<string>('API_URL', 'http://localhost:3001');
        const webhookUrl = `${apiUrl}/api/events/waha?workerId=${worker.id}&secret=${worker.ingressSecret}`;
        await this.wahaService.resetSession(
          worker.internalIp,
          worker.apiKeyEnc,
          wahaName,
          webhookUrl,
        );
        await this.db
          .update(wahaSessions)
          .set({ status: 'scan_qr', updatedAt: new Date() })
          .where(eq(wahaSessions.id, idle.id));
      }
    } else {
      // 2b. No idle connection — create a new one
      const created = await this.createConnection(user);
      connectionId = created.id;
    }

    // 3. Poll for QR (up to 10 attempts, 2s apart)
    for (let i = 0; i < 10; i++) {
      try {
        const qr = await this.getQrCode(connectionId, user);
        if (qr && 'connected' in qr && qr.connected) {
          return { id: connectionId, status: 'connected', qr: null };
        }
        if (qr && 'value' in qr) {
          return { id: connectionId, status: 'scan_qr', qr: qr.value };
        }
      } catch {
        // Worker not ready yet
      }
      await new Promise((r) => setTimeout(r, 2000));
    }

    // Return without QR if polling timed out — client can fetch it separately
    return { id: connectionId, status: 'pending', qr: null };
  }

  @Post()
  async createConnection(
    @CurrentUser() user: { sub: string },
    @Body() body?: { name?: string },
  ) {
    const shortUserId = user.sub.replace(/-/g, '').slice(0, 12);
    const shortSessionId = randomBytes(6).toString('hex');
    const sessionName = `u_${shortUserId}_s_${shortSessionId}`;

    const [created] = await this.db
      .insert(wahaSessions)
      .values({
        userId: user.sub,
        name: body?.name || null,
        sessionName,
        status: 'pending',
        engine: 'NOWEB',
      })
      .returning();

    // Do worker setup + WAHA session creation in background.
    // The frontend polls QR immediately; health check handles failures.
    this.setupWorkerAndSession(created.id, sessionName).catch((error) => {
      this.logger.warn(
        `WAHA setup deferred for ${created.id}: ${error instanceof Error ? error.message : String(error)}`,
      );
    });

    return this.mapConnection(created);
  }

  private async setupWorkerAndSession(connectionId: string, sessionName: string) {
    const worker = await Promise.race([
      this.workersService.findOrProvisionWorker(),
      new Promise<never>((_, reject) =>
        setTimeout(() => reject(new Error('Worker provisioning timeout')), 15000),
      ),
    ]);

    await this.workersService.assignSession(worker.id, connectionId);

    const apiUrl = this.configService.get<string>('API_URL', 'http://localhost:3001');
    const webhookUrl = `${apiUrl}/api/events/waha?workerId=${worker.id}&secret=${worker.ingressSecret}`;
    const wahaName = this.wahaService.resolveSessionName(sessionName);

    await this.wahaService.resetSession(
      worker.internalIp,
      worker.apiKey,
      wahaName,
      webhookUrl,
    );

    await this.db
      .update(wahaSessions)
      .set({ status: 'scan_qr', updatedAt: new Date() })
      .where(eq(wahaSessions.id, connectionId));
  }

  @Get(':id/qr')
  async getQrCode(
    @Param('id') id: string,
    @CurrentUser() user: { sub: string },
  ) {
    const [connection] = await this.db
      .select()
      .from(wahaSessions)
      .where(eq(wahaSessions.id, id));

    if (!connection) {
      throw new NotFoundException('Connection not found');
    }

    if (connection.userId !== user.sub) {
      throw new ForbiddenException('You do not own this connection');
    }

    const worker = await this.workersService.getWorkerForSession(id);

    if (!worker) {
      throw new ServiceUnavailableException(
        'Worker is being provisioned, please wait',
      );
    }

    const wahaName = this.wahaService.resolveSessionName(
      connection.sessionName,
    );

    // Each frontend poll starts a new 10-attempt retry loop.
    // After a QR is returned successfully, peek at session to detect if the user scanned.
    for (let attempt = 0; attempt < 10; attempt++) {
      try {
        // Before fetching QR, check if session is already past scanning phase
        if (attempt === 0) {
          try {
            const preCheck = await this.wahaService.getSession(
              worker.internalIp, worker.apiKeyEnc, wahaName,
            );
            if (preCheck.status === 'WORKING') {
              const updates: Record<string, any> = { status: 'working', updatedAt: new Date() };
              try {
                const me = await this.wahaService.getMe(worker.internalIp, worker.apiKeyEnc, wahaName);
                const phone = me?.id?.replace('@c.us', '') || null;
                if (phone) updates.phoneNumber = phone;
              } catch { /* non-critical */ }
              await this.db.update(wahaSessions).set(updates).where(eq(wahaSessions.id, id));
              return { connected: true };
            }
            if (preCheck.status !== 'SCAN_QR_CODE') {
              // Transitioning — wait and retry
            }
          } catch { /* pre-check failed, continue */ }
        }

        const qr = await this.wahaService.getQrCode(
          worker.internalIp, worker.apiKeyEnc, wahaName,
        );
        return qr;
      } catch (err) {
        // If WAHA says the session is already WORKING, return connected immediately
        const errMsg = err instanceof Error ? err.message : String(err);
        if (errMsg.includes('"status":"WORKING"') || errMsg.includes('already connected')) {
          const updates: Record<string, any> = { status: 'working', updatedAt: new Date() };
          try {
            const me = await this.wahaService.getMe(worker.internalIp, worker.apiKeyEnc, wahaName);
            const phone = me?.id?.replace('@c.us', '') || null;
            if (phone) updates.phoneNumber = phone;
          } catch { /* non-critical */ }
          await this.db.update(wahaSessions).set(updates).where(eq(wahaSessions.id, id));
          return { connected: true };
        }

        // Between attempts when QR fails, peek at session status
        if (attempt >= 2 && attempt % 2 === 1) {
          try {
            const peek = await this.wahaService.getSession(
              worker.internalIp, worker.apiKeyEnc, wahaName,
            );
            if (peek.status === 'WORKING') {
              const updates: Record<string, any> = { status: 'working', updatedAt: new Date() };
              try {
                const me = await this.wahaService.getMe(worker.internalIp, worker.apiKeyEnc, wahaName);
                const phone = me?.id?.replace('@c.us', '') || null;
                if (phone) updates.phoneNumber = phone;
              } catch { /* non-critical */ }
              await this.db.update(wahaSessions).set(updates).where(eq(wahaSessions.id, id));
              return { connected: true };
            }
          } catch { /* peek failed, keep retrying */ }
        }
        if (attempt < 9) {
          await new Promise((r) => setTimeout(r, 2000));
          continue;
        }
      }
    }

    // All QR attempts exhausted — final session status check
    try {
      const session = await this.wahaService.getSession(
        worker.internalIp,
        worker.apiKeyEnc,
        wahaName,
      );
      if (session.status === 'WORKING') {
        const updates: Record<string, any> = { status: 'working', updatedAt: new Date() };
        try {
          const me = await this.wahaService.getMe(worker.internalIp, worker.apiKeyEnc, wahaName);
          const phone = me?.id?.replace('@c.us', '') || null;
          if (phone) updates.phoneNumber = phone;
        } catch { /* non-critical */ }
        await this.db
          .update(wahaSessions)
          .set(updates)
          .where(eq(wahaSessions.id, id));
        return { connected: true };
      }
      if (session.status === 'FAILED' || session.status === 'STOPPED') {
        this.logger.log(
          `Session ${wahaName} is ${session.status}, resetting with full config...`,
        );
        const apiUrl = this.configService.get<string>('API_URL', 'http://localhost:3001');
        const webhookUrl = `${apiUrl}/api/events/waha?workerId=${worker.id}&secret=${worker.ingressSecret}`;
        await this.wahaService.resetSession(
          worker.internalIp, worker.apiKeyEnc, wahaName, webhookUrl,
        );
        await this.db
          .update(wahaSessions)
          .set({ status: 'scan_qr', updatedAt: new Date() })
          .where(eq(wahaSessions.id, id));
      }
    } catch {
      // Session check also failed — worker is genuinely unavailable
    }
    throw new ServiceUnavailableException(
      'Worker is starting up, please wait',
    );
  }

  @Post(':id/restart')
  async restartConnection(
    @Param('id') id: string,
    @CurrentUser() user: { sub: string },
  ) {
    const [connection] = await this.db
      .select()
      .from(wahaSessions)
      .where(eq(wahaSessions.id, id));

    if (!connection) {
      throw new NotFoundException('Connection not found');
    }

    if (connection.userId !== user.sub) {
      throw new ForbiddenException('You do not own this connection');
    }

    const worker = await this.workersService.getWorkerForSession(id);

    if (!worker) {
      throw new NotFoundException('No worker assigned to this connection');
    }

    const wahaName = this.wahaService.resolveSessionName(
      connection.sessionName,
    );

    const apiUrl = this.configService.get<string>(
      'API_URL',
      'http://localhost:3001',
    );
    const webhookUrl = `${apiUrl}/api/events/waha?workerId=${worker.id}&secret=${worker.ingressSecret}`;

    // Always do a full reset to ensure webhook URL and store config are preserved.
    // restartSession doesn't re-apply config, so webhooks silently break after pod restarts.
    await this.wahaService.resetSession(
      worker.internalIp,
      worker.apiKeyEnc,
      wahaName,
      webhookUrl,
    );

    const [updated] = await this.db
      .update(wahaSessions)
      .set({ status: 'scan_qr', updatedAt: new Date() })
      .where(eq(wahaSessions.id, id))
      .returning();

    return updated;
  }

  @Get(':id/chats')
  async getChats(
    @Param('id') id: string,
    @CurrentUser() user: { sub: string },
  ) {
    const [connection] = await this.db
      .select()
      .from(wahaSessions)
      .where(eq(wahaSessions.id, id));

    if (!connection) {
      throw new NotFoundException('Connection not found');
    }

    if (connection.userId !== user.sub) {
      throw new ForbiddenException('You do not own this connection');
    }

    const worker = await this.workersService.getWorkerForSession(id);

    if (!worker) {
      return [];
    }

    const wahaName = this.wahaService.resolveSessionName(
      connection.sessionName,
    );

    try {
      return await this.wahaService.getChats(
        worker.internalIp,
        worker.apiKeyEnc,
        wahaName,
      );
    } catch {
      return [];
    }
  }

  @Get(':id/chats/:chatId/messages')
  async getMessages(
    @Param('id') id: string,
    @Param('chatId') chatId: string,
    @CurrentUser() user: { sub: string },
  ) {
    const [connection] = await this.db
      .select()
      .from(wahaSessions)
      .where(eq(wahaSessions.id, id));

    if (!connection) {
      throw new NotFoundException('Connection not found');
    }

    if (connection.userId !== user.sub) {
      throw new ForbiddenException('You do not own this connection');
    }

    const worker = await this.workersService.getWorkerForSession(id);

    if (!worker) {
      return [];
    }

    const wahaName = this.wahaService.resolveSessionName(
      connection.sessionName,
    );

    try {
      return await this.wahaService.getMessages(
        worker.internalIp,
        worker.apiKeyEnc,
        wahaName,
        chatId,
      );
    } catch {
      return [];
    }
  }

  @Get(':id/me')
  async getMe(
    @Param('id') id: string,
    @CurrentUser() user: { sub: string },
  ) {
    const [connection] = await this.db
      .select()
      .from(wahaSessions)
      .where(eq(wahaSessions.id, id));

    if (!connection) {
      throw new NotFoundException('Connection not found');
    }

    if (connection.userId !== user.sub) {
      throw new ForbiddenException('You do not own this connection');
    }

    const worker = await this.workersService.getWorkerForSession(id);

    if (!worker) {
      return null;
    }

    const wahaName = this.wahaService.resolveSessionName(
      connection.sessionName,
    );

    try {
      return await this.wahaService.getMe(
        worker.internalIp,
        worker.apiKeyEnc,
        wahaName,
      );
    } catch {
      return null;
    }
  }

  @Get(':id/contacts/:contactId/picture')
  async getContactPicture(
    @Param('id') id: string,
    @Param('contactId') contactId: string,
    @CurrentUser() user: { sub: string },
  ) {
    const [connection] = await this.db
      .select()
      .from(wahaSessions)
      .where(eq(wahaSessions.id, id));

    if (!connection) throw new NotFoundException('Connection not found');
    if (connection.userId !== user.sub) throw new ForbiddenException('You do not own this connection');

    const worker = await this.workersService.getWorkerForSession(id);
    if (!worker) return { profilePictureUrl: null };

    const wahaName = this.wahaService.resolveSessionName(connection.sessionName);
    return this.wahaService.getProfilePicture(
      worker.internalIp, worker.apiKeyEnc, wahaName, contactId,
    );
  }

  @Post(':id/send')
  async sendText(
    @Param('id') id: string,
    @Body() body: { chatId: string; text: string; skipPresence?: boolean; replyTo?: string },
    @CurrentUser() user: { sub: string },
  ) {
    const { worker, wahaName } = await this.resolveWorker(id, user.sub);

    // Anti-spam: rate limit + warmup gate + humanized delay calculation.
    // Throws TooManyRequestsException (429) if any limit is breached.
    const extraDelayMs = await this.antiSpamService.checkAndThrottle(
      id,
      body.chatId,
      body.text.length,
    );

    // During warmup, add extra inter-message delay on top of the human delay
    const warmupDelay = this.antiSpamService.getWarmupBatchDelay(id);
    if (warmupDelay > 0) {
      await new Promise((r) => setTimeout(r, warmupDelay));
    }

    return this.wahaService.sendText(
      worker.internalIp,
      worker.apiKeyEnc,
      wahaName,
      body.chatId,
      body.text,
      { skipPresence: body.skipPresence, replyTo: body.replyTo, extraDelayMs },
    );
  }

  @Post(':id/react')
  async sendReaction(
    @Param('id') id: string,
    @Body() body: { chatId: string; messageId: string; reaction: string },
    @CurrentUser() user: { sub: string },
  ) {
    const { worker, wahaName } = await this.resolveWorker(id, user.sub);
    await this.wahaService.sendReaction(
      worker.internalIp,
      worker.apiKeyEnc,
      wahaName,
      body.chatId,
      body.messageId,
      body.reaction,
    );
    return { success: true };
  }

  @Get(':id/media/:filename')
  async getMedia(
    @Param('id') id: string,
    @Param('filename') filename: string,
    @CurrentUser() user: { sub: string },
  ): Promise<StreamableFile> {
    // Sanitize filename — reject path traversal
    if (filename.includes('..') || filename.includes('/') || filename.includes('\\')) {
      throw new NotFoundException('Invalid filename');
    }

    const { worker, wahaName } = await this.resolveWorker(id, user.sub);

    // Fetch from WAHA worker's internal file endpoint
    const wahaUrl = `http://${worker.internalIp}:3000/api/files/${encodeURIComponent(wahaName)}/${encodeURIComponent(filename)}`;
    const wahaRes = await fetch(wahaUrl, {
      headers: { 'X-Api-Key': worker.apiKeyEnc },
    });

    if (!wahaRes.ok || !wahaRes.body) {
      throw new NotFoundException('Media not found');
    }

    const contentType = wahaRes.headers.get('content-type') || 'application/octet-stream';

    // Convert web ReadableStream to Node Buffer
    const chunks: Uint8Array[] = [];
    const reader = wahaRes.body.getReader();
    let done = false;
    while (!done) {
      const result = await reader.read();
      done = result.done;
      if (result.value) chunks.push(result.value);
    }
    const buffer = Buffer.concat(chunks);

    return new StreamableFile(buffer, { type: contentType });
  }

  @Post(':id/mark-read')
  async markRead(
    @Param('id') id: string,
    @Body() body: { chatId: string },
    @CurrentUser() user: { sub: string },
  ) {
    const { worker, wahaName } = await this.resolveWorker(id, user.sub);
    await this.wahaService.sendSeen(worker.internalIp, worker.apiKeyEnc, wahaName, body.chatId);
    return { success: true };
  }

  @Post(':id/typing')
  async startTyping(
    @Param('id') id: string,
    @Body() body: { chatId: string },
    @CurrentUser() user: { sub: string },
  ) {
    const { worker, wahaName } = await this.resolveWorker(id, user.sub);
    await this.wahaService.startTyping(worker.internalIp, worker.apiKeyEnc, wahaName, body.chatId);
    return { success: true };
  }

  @Post(':id/typing/stop')
  async stopTyping(
    @Param('id') id: string,
    @Body() body: { chatId: string },
    @CurrentUser() user: { sub: string },
  ) {
    const { worker, wahaName } = await this.resolveWorker(id, user.sub);
    await this.wahaService.stopTyping(worker.internalIp, worker.apiKeyEnc, wahaName, body.chatId);
    return { success: true };
  }

  @Patch(':id')
  async updateConnection(
    @Param('id') id: string,
    @Body() body: { name?: string },
    @CurrentUser() user: { sub: string },
  ) {
    const [connection] = await this.db
      .select()
      .from(wahaSessions)
      .where(eq(wahaSessions.id, id));

    if (!connection) throw new NotFoundException('Connection not found');
    if (connection.userId !== user.sub) throw new ForbiddenException('You do not own this connection');

    const updates: Record<string, any> = { updatedAt: new Date() };
    if (body.name !== undefined) updates.name = body.name || null;

    const [updated] = await this.db
      .update(wahaSessions)
      .set(updates)
      .where(eq(wahaSessions.id, id))
      .returning();

    return this.mapConnection(updated);
  }

  /** Resolve connection → worker → wahaName, with ownership check */
  private async resolveWorker(id: string, userId: string) {
    const [connection] = await this.db
      .select()
      .from(wahaSessions)
      .where(eq(wahaSessions.id, id));
    if (!connection) throw new NotFoundException('Connection not found');
    if (connection.userId !== userId) throw new ForbiddenException('You do not own this connection');
    const worker = await this.workersService.getWorkerForSession(id);
    if (!worker) throw new ServiceUnavailableException('No worker assigned');
    const wahaName = this.wahaService.resolveSessionName(connection.sessionName);
    return { worker, wahaName };
  }

  @Post(':id/send-image')
  async sendImage(
    @Param('id') id: string,
    @Body() body: { chatId: string; url?: string; data?: string; mimetype?: string; caption?: string; skipPresence?: boolean },
    @CurrentUser() user: { sub: string },
  ) {
    const { worker, wahaName } = await this.resolveWorker(id, user.sub);
    const extraDelayMs = await this.antiSpamService.checkAndThrottle(id, body.chatId, body.caption?.length ?? 20);
    const warmupDelay = this.antiSpamService.getWarmupBatchDelay(id);
    if (warmupDelay > 0) await new Promise((r) => setTimeout(r, warmupDelay));
    return this.wahaService.sendImage(
      worker.internalIp, worker.apiKeyEnc, wahaName,
      body.chatId, body.url, body.caption, body.data, body.mimetype,
      { skipPresence: body.skipPresence, extraDelayMs },
    );
  }

  @Post(':id/send-document')
  async sendDocument(
    @Param('id') id: string,
    @Body() body: { chatId: string; url?: string; data?: string; mimetype?: string; filename?: string; caption?: string; skipPresence?: boolean },
    @CurrentUser() user: { sub: string },
  ) {
    const { worker, wahaName } = await this.resolveWorker(id, user.sub);
    const extraDelayMs = await this.antiSpamService.checkAndThrottle(id, body.chatId, body.caption?.length ?? 20);
    const warmupDelay = this.antiSpamService.getWarmupBatchDelay(id);
    if (warmupDelay > 0) await new Promise((r) => setTimeout(r, warmupDelay));
    return this.wahaService.sendFile(
      worker.internalIp, worker.apiKeyEnc, wahaName,
      body.chatId, body.url, body.filename, body.caption, body.data, body.mimetype,
      { skipPresence: body.skipPresence, extraDelayMs },
    );
  }

  @Post(':id/send-video')
  async sendVideo(
    @Param('id') id: string,
    @Body() body: { chatId: string; url?: string; data?: string; mimetype?: string; caption?: string; skipPresence?: boolean },
    @CurrentUser() user: { sub: string },
  ) {
    const { worker, wahaName } = await this.resolveWorker(id, user.sub);
    const extraDelayMs = await this.antiSpamService.checkAndThrottle(id, body.chatId, body.caption?.length ?? 20);
    const warmupDelay = this.antiSpamService.getWarmupBatchDelay(id);
    if (warmupDelay > 0) await new Promise((r) => setTimeout(r, warmupDelay));
    return this.wahaService.sendVideo(
      worker.internalIp, worker.apiKeyEnc, wahaName,
      body.chatId, body.url, body.caption, body.data, body.mimetype,
      { skipPresence: body.skipPresence, extraDelayMs },
    );
  }

  @Post(':id/send-audio')
  async sendAudio(
    @Param('id') id: string,
    @Body() body: { chatId: string; url?: string; data?: string; mimetype?: string; skipPresence?: boolean },
    @CurrentUser() user: { sub: string },
  ) {
    const { worker, wahaName } = await this.resolveWorker(id, user.sub);
    const extraDelayMs = await this.antiSpamService.checkAndThrottle(id, body.chatId, 20);
    const warmupDelay = this.antiSpamService.getWarmupBatchDelay(id);
    if (warmupDelay > 0) await new Promise((r) => setTimeout(r, warmupDelay));
    return this.wahaService.sendVoice(
      worker.internalIp, worker.apiKeyEnc, wahaName,
      body.chatId, body.url, body.data, body.mimetype,
      { skipPresence: body.skipPresence, extraDelayMs },
    );
  }

  @Post(':id/send-location')
  async sendLocation(
    @Param('id') id: string,
    @Body() body: { chatId: string; latitude: number; longitude: number; name?: string; address?: string; skipPresence?: boolean },
    @CurrentUser() user: { sub: string },
  ) {
    const { worker, wahaName } = await this.resolveWorker(id, user.sub);
    const extraDelayMs = await this.antiSpamService.checkAndThrottle(id, body.chatId, 20);
    const warmupDelay = this.antiSpamService.getWarmupBatchDelay(id);
    if (warmupDelay > 0) await new Promise((r) => setTimeout(r, warmupDelay));
    return this.wahaService.sendLocation(
      worker.internalIp, worker.apiKeyEnc, wahaName,
      body.chatId, body.latitude, body.longitude, body.name, body.address,
      { skipPresence: body.skipPresence, extraDelayMs },
    );
  }

  @Post(':id/send-contact')
  async sendContact(
    @Param('id') id: string,
    @Body() body: { chatId: string; contactName: string; contactPhone: string; skipPresence?: boolean },
    @CurrentUser() user: { sub: string },
  ) {
    const { worker, wahaName } = await this.resolveWorker(id, user.sub);
    const extraDelayMs = await this.antiSpamService.checkAndThrottle(id, body.chatId, 20);
    const warmupDelay = this.antiSpamService.getWarmupBatchDelay(id);
    if (warmupDelay > 0) await new Promise((r) => setTimeout(r, warmupDelay));
    return this.wahaService.sendContactVcard(
      worker.internalIp, worker.apiKeyEnc, wahaName,
      body.chatId, body.contactName, body.contactPhone,
      { skipPresence: body.skipPresence, extraDelayMs },
    );
  }

  @Get(':id')
  async getConnection(
    @Param('id') id: string,
    @CurrentUser() user: { sub: string },
  ) {
    const [connection] = await this.db
      .select()
      .from(wahaSessions)
      .where(eq(wahaSessions.id, id));

    if (!connection) {
      throw new NotFoundException('Connection not found');
    }

    if (connection.userId !== user.sub) {
      throw new ForbiddenException('You do not own this connection');
    }

    return this.mapConnection(connection);
  }

  @Delete(':id')
  async deleteConnection(
    @Param('id') id: string,
    @CurrentUser() user: { sub: string },
  ) {
    const [connection] = await this.db
      .select()
      .from(wahaSessions)
      .where(eq(wahaSessions.id, id));

    if (!connection) {
      throw new NotFoundException('Connection not found');
    }

    if (connection.userId !== user.sub) {
      throw new ForbiddenException('You do not own this connection');
    }

    try {
      const worker = await this.workersService.getWorkerForSession(id);

      if (worker) {
        const wahaName = this.wahaService.resolveSessionName(
          connection.sessionName,
        );
        // Full cleanup: stop → logout → delete (drops WAHA's per-session database)
        try {
          await this.wahaService.stopSession(worker.internalIp, worker.apiKeyEnc, wahaName);
        } catch { /* may already be stopped */ }
        try {
          await this.wahaService.logoutSession(worker.internalIp, worker.apiKeyEnc, wahaName);
        } catch { /* ignore */ }
        try {
          await this.wahaService.deleteSession(worker.internalIp, worker.apiKeyEnc, wahaName);
        } catch { /* ignore */ }
        await this.workersService.unassignSession(worker.id, id);
      }
    } catch (error) {
      this.logger.error(
        `Failed to stop WAHA session for connection ${id}: ${error instanceof Error ? error.message : String(error)}`,
      );
    }

    const [updated] = await this.db
      .update(wahaSessions)
      .set({ status: 'stopped', updatedAt: new Date() })
      .where(eq(wahaSessions.id, id))
      .returning();

    return updated;
  }
}
