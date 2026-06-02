import { Controller, Post, Body, Query, Inject, Logger, UnauthorizedException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Throttle } from '@nestjs/throttler';
import { InjectQueue } from '@nestjs/bullmq';
import { Queue } from 'bullmq';
import { timingSafeEqual } from 'crypto';
import { eq, and, not } from 'drizzle-orm';
import { wahaSessions, wahaWorkers, webhookConfigs, webhookEventLogs } from '@wago/db';
import { DRIZZLE_TOKEN } from '../database/database.module';
import { WahaService } from '../waha/waha.service';
import { EventsGateway } from './events.gateway';

const AI_RESPONSE_QUEUE = 'ai-response';

interface WahaEvent {
  event: string;
  // WAHA format uses "session"; Evolution API format uses "instance" — normalised below
  session?: string;
  instance?: string;
  // WAHA format uses "payload"; Evolution API format uses "data" — normalised below
  payload?: unknown;
  data?: unknown;
  [key: string]: unknown;
}

@Controller('events')
export class EventsController {
  private readonly logger = new Logger(EventsController.name);

  constructor(
    @Inject(DRIZZLE_TOKEN) private readonly db: any,
    @InjectQueue('webhook-delivery') private readonly webhookQueue: Queue,
    @InjectQueue(AI_RESPONSE_QUEUE) private readonly aiResponseQueue: Queue,
    private readonly wahaService: WahaService,
    private readonly eventsGateway: EventsGateway,
    private readonly configService: ConfigService,
  ) {}

  /**
   * Ingestion endpoint for WAHA webhook events.
   * No auth guard — this receives internal traffic from WAHA worker containers.
   */
  @Throttle({ default: { limit: 300, ttl: 60000 } })
  @Post('waha')
  async ingestWahaEvent(
    @Body() event: WahaEvent,
    @Query('workerId') workerId?: string,
    @Query('secret') secret?: string,
  ) {
    // Verify ingress secret — required on all requests
    if (!workerId || !secret) {
      throw new UnauthorizedException('Missing workerId or secret');
    }

    const workers = await this.db
      .select()
      .from(wahaWorkers)
      .where(eq(wahaWorkers.id, workerId))
      .limit(1);

    const worker = workers[0];
    if (!worker || !worker.ingressSecret) {
      throw new UnauthorizedException('Invalid workerId');
    }

    try {
      const expected = Buffer.from(worker.ingressSecret);
      const received = Buffer.from(secret);
      if (expected.length !== received.length || !timingSafeEqual(expected, received)) {
        throw new Error('mismatch');
      }
    } catch {
      throw new UnauthorizedException('Invalid ingress secret');
    }

    // Normalise format differences between WAHA and Evolution API:
    // WAHA:          { event, session, payload }
    // Evolution API: { event, instance, data }
    const sessionName: string = (event.session ?? event.instance ?? 'default') as string;
    const payload: any = event.payload ?? event.data;

    // Normalize Evolution API event names to WAHA-compatible names
    const EVENT_MAP: Record<string, string> = {
      'MESSAGES_UPSERT':    'message',
      'MESSAGES_UPDATE':    'message.ack',
      'MESSAGES_DELETE':    'message.revoked',
      'SEND_MESSAGE':       'message',
      'CONNECTION_UPDATE':  'session.status',
      'QRCODE_UPDATED':     'session.status',
      'PRESENCE_UPDATE':    'presence.update',
      'GROUPS_UPSERT':      'group.join',
      'GROUP_PARTICIPANTS_UPDATE': 'group.leave',
    };
    const normalizedEvent = EVENT_MAP[event.event] ?? event.event;

    this.logger.log(`Received event: ${event.event} → ${normalizedEvent} for session: ${sessionName}`);

    // 1. Look up the session using workerId (always present after validation above)
    let session: any;
    if (
      sessionName === 'default' &&
      this.wahaService.getMaxSessions() === 1
    ) {
      const sessions = await this.db
        .select()
        .from(wahaSessions)
        .where(
          and(
            eq(wahaSessions.workerId, workerId),
            not(eq(wahaSessions.status, 'stopped')),
          ),
        )
        .limit(1);
      session = sessions[0];
    } else {
      const sessions = await this.db
        .select()
        .from(wahaSessions)
        .where(eq(wahaSessions.sessionName, sessionName));
      session = sessions[0];
    }

    if (!session) {
      this.logger.warn(`No session found for sessionName: ${sessionName}, ignoring event`);
      return { received: true };
    }

    // 1b. If this is an incoming text message, enqueue an AI auto-response job (fire-and-forget)
    if (
      (normalizedEvent === 'message' || event.event === 'messages.upsert' || event.event === 'message') &&
      payload?.key?.fromMe === false &&
      payload?.message
    ) {
      const chatId: string | undefined = payload?.key?.remoteJid;
      const text: string | undefined =
        payload?.message?.conversation ||
        payload?.message?.extendedTextMessage?.text;

      if (chatId && text) {
        this.aiResponseQueue
          .add(
            'respond',
            {
              connectionId: session.id,
              sessionId: session.id,
              userId: session.userId,
              chatId,
              incomingMessage: text,
              // Worker IP and API key are resolved from DB inside the processor — never stored in queue
            },
            { attempts: 2, backoff: { type: 'fixed', delay: 5000 } },
          )
          .catch((err: unknown) => {
            this.logger.warn(
              `Failed to enqueue AI response job: ${err instanceof Error ? err.message : String(err)}`,
            );
          });
      }
    }

    // 2. Normalize Evolution API media payloads.
    // Evolution API embeds media info inside message.{documentMessage|imageMessage|...}
    // We extract it into a top-level `media` object with a proxied download URL so
    // consumers never need access to internal worker hostnames or WhatsApp CDN tokens.
    const rewrittenPayload = { ...(payload as any) };
    const apiUrl = this.configService.get<string>('API_URL', 'http://localhost:3001');

    const MEDIA_MESSAGE_TYPES = [
      'documentMessage',
      'imageMessage',
      'videoMessage',
      'audioMessage',
      'stickerMessage',
    ] as const;

    const detectedMediaType = MEDIA_MESSAGE_TYPES.find(
      (t) => rewrittenPayload?.messageType === t || rewrittenPayload?.message?.[t],
    );

    if (detectedMediaType) {
      const mediaMsg = rewrittenPayload.message?.[detectedMediaType] ?? {};
      const messageId: string | undefined = rewrittenPayload?.key?.id;
      const remoteJid: string | undefined = rewrittenPayload?.key?.remoteJid;
      const fromMe: boolean = rewrittenPayload?.key?.fromMe ?? false;

      if (messageId && remoteJid) {
        const proxyUrl =
          `${apiUrl}/api/connections/${session.id}/media/${encodeURIComponent(messageId)}` +
          `?remoteJid=${encodeURIComponent(remoteJid)}&fromMe=${fromMe}`;

        rewrittenPayload.media = {
          url: proxyUrl,
          mimetype: mediaMsg.mimetype ?? 'application/octet-stream',
          filename: mediaMsg.fileName ?? mediaMsg.title ?? detectedMediaType.replace('Message', ''),
          mediaType: detectedMediaType.replace('Message', ''),
        };
      }
    } else if (rewrittenPayload.media?.url) {
      // Legacy WAHA path — keep working if ever reverted
      const filename = rewrittenPayload.media.url.split('/').pop();
      rewrittenPayload.media = {
        ...rewrittenPayload.media,
        url: `${apiUrl}/api/connections/${session.id}/media/${filename}`,
      };
    }

    const rewrittenEvent = { ...event, payload: rewrittenPayload };

    this.eventsGateway.broadcastEvent(session.id, session.userId, {
      event: event.event,
      connectionId: session.id,
      payload: rewrittenPayload,
      timestamp: new Date().toISOString(),
    });

    // 3. Find all active webhook configs for this session
    const configs = await this.db
      .select()
      .from(webhookConfigs)
      .where(
        and(
          eq(webhookConfigs.sessionId, session.id),
          eq(webhookConfigs.active, true),
        ),
      );

    // 3. Filter configs — match normalized event name OR original
    const matchingConfigs = configs.filter(
      (config: { events: string[] }) =>
        config.events.includes('*') ||
        config.events.includes(normalizedEvent) ||
        config.events.includes(event.event),
    );

    if (matchingConfigs.length === 0) {
      this.logger.debug(
        `No matching webhook configs for event ${event.event} (normalized: ${normalizedEvent}) on session ${session.id}`,
      );
      return { received: true };
    }

    // 4. For each matching config, create a log entry and enqueue a delivery job
    for (const config of matchingConfigs) {
      const [log] = await this.db
        .insert(webhookEventLogs)
        .values({
          webhookConfigId: config.id,
          eventType: normalizedEvent,
          payload: rewrittenEvent,
          status: 'pending',
        })
        .returning();

      await this.webhookQueue.add('deliver', {
        webhookConfigId: config.id,
        url: config.url,
        signingSecret: config.signingSecret,
        eventType: normalizedEvent,
        payload: rewrittenEvent,
        sessionId: session.id,
        logId: log.id,
      });

      this.logger.log(
        `Enqueued webhook delivery ${log.id} to ${config.url} for event ${normalizedEvent}`,
      );
    }

    return { received: true };
  }
}
