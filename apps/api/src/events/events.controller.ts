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

interface WahaEvent {
  event: string;
  session: string;
  payload?: unknown;
  [key: string]: unknown;
}

@Controller('events')
export class EventsController {
  private readonly logger = new Logger(EventsController.name);

  constructor(
    @Inject(DRIZZLE_TOKEN) private readonly db: any,
    @InjectQueue('webhook-delivery') private readonly webhookQueue: Queue,
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

    this.logger.log(
      `Received WAHA event: ${event.event} for session: ${event.session}`,
    );

    // 1. Look up the session using workerId (always present after validation above)
    let session: any;
    if (
      event.session === 'default' &&
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
        .where(eq(wahaSessions.sessionName, event.session));
      session = sessions[0];
    }

    if (!session) {
      this.logger.warn(
        `No session found for sessionName: ${event.session}, ignoring event`,
      );
      return { received: true };
    }

    // 2. Rewrite internal WAHA media URLs to the externally-resolvable proxy URL.
    // Applies to both WebSocket broadcasts AND outbound webhook deliveries so
    // customers can fetch media without exposing internal WAHA worker hostnames.
    const rewrittenPayload = { ...(event.payload as any) };
    if (rewrittenPayload.media?.url) {
      const filename = rewrittenPayload.media.url.split('/').pop();
      const apiUrl = this.configService.get<string>('API_URL', 'http://localhost:3001');
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

    // 3. Filter configs whose events array contains the event type
    const matchingConfigs = configs.filter(
      (config: { events: string[] }) =>
        config.events.includes('*') || config.events.includes(event.event),
    );

    if (matchingConfigs.length === 0) {
      this.logger.debug(
        `No matching webhook configs for event ${event.event} on session ${session.id}`,
      );
      return { received: true };
    }

    // 4. For each matching config, create a log entry and enqueue a delivery job
    for (const config of matchingConfigs) {
      const [log] = await this.db
        .insert(webhookEventLogs)
        .values({
          webhookConfigId: config.id,
          eventType: event.event,
          payload: rewrittenEvent,
          status: 'pending',
        })
        .returning();

      await this.webhookQueue.add('deliver', {
        webhookConfigId: config.id,
        url: config.url,
        signingSecret: config.signingSecret,
        eventType: event.event,
        payload: rewrittenEvent,
        sessionId: session.id,
        logId: log.id,
      });

      this.logger.log(
        `Enqueued webhook delivery ${log.id} to ${config.url} for event ${event.event}`,
      );
    }

    return { received: true };
  }
}
