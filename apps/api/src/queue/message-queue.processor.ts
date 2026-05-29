import { Processor, WorkerHost } from '@nestjs/bullmq';
import { Logger, Inject } from '@nestjs/common';
import { Job } from 'bullmq';
import { eq, and } from 'drizzle-orm';
import { messageQueue, wahaSessions } from '@wago/db';
import { DRIZZLE_TOKEN } from '../database/database.module';
import { WahaService } from '../waha/waha.service';
import { WorkersService } from '../workers/workers.service';
import { AntiSpamService } from '../waha/anti-spam.service';

export interface MessageJobData {
  messageId: string;
}

@Processor('message-queue', { concurrency: 2 })
export class MessageQueueProcessor extends WorkerHost {
  private readonly logger = new Logger(MessageQueueProcessor.name);

  constructor(
    @Inject(DRIZZLE_TOKEN) private readonly db: any,
    private readonly wahaService: WahaService,
    private readonly workersService: WorkersService,
    private readonly antiSpamService: AntiSpamService,
  ) {
    super();
  }

  async process(job: Job<MessageJobData>): Promise<void> {
    const { messageId } = job.data;

    // Load message from DB
    const [msg] = await this.db
      .select()
      .from(messageQueue)
      .where(eq(messageQueue.id, messageId));

    if (!msg) {
      this.logger.warn(`Message ${messageId} not found, skipping`);
      return;
    }

    if (msg.status === 'sent' || msg.status === 'cancelled') {
      this.logger.log(`Message ${messageId} already ${msg.status}, skipping`);
      return;
    }

    // Check if scheduled time has arrived
    if (msg.scheduledAt && new Date(msg.scheduledAt) > new Date()) {
      this.logger.log(`Message ${messageId} scheduled for ${msg.scheduledAt}, requeueing`);
      throw new Error('Not yet scheduled'); // BullMQ will retry with delay
    }

    // Mark as processing
    await this.db
      .update(messageQueue)
      .set({ status: 'processing', updatedAt: new Date() })
      .where(eq(messageQueue.id, messageId));

    try {
      // Find an active connection for this user if connectionId is set
      let connectionId = msg.connectionId;
      if (!connectionId) {
        // Find any active connection for the user
        const [activeSession] = await this.db
          .select()
          .from(wahaSessions)
          .where(and(
            eq(wahaSessions.userId, msg.userId),
            eq(wahaSessions.status, 'working'),
          ));
        if (!activeSession) {
          throw new Error('No active WhatsApp connection available');
        }
        connectionId = activeSession.id;
      } else {
        // Verify connection is active
        const [session] = await this.db
          .select()
          .from(wahaSessions)
          .where(eq(wahaSessions.id, connectionId));
        if (!session || session.status !== 'working') {
          throw new Error(`Connection ${connectionId} is not active (status: ${session?.status ?? 'not found'})`);
        }
      }

      const worker = await this.workersService.getWorkerForSession(connectionId);
      if (!worker) {
        throw new Error(`No worker assigned to connection ${connectionId}`);
      }

      const [session] = await this.db.select().from(wahaSessions).where(eq(wahaSessions.id, connectionId));
      const wahaName = this.wahaService.resolveSessionName(session.sessionName);

      // Anti-spam rate limiting
      const content = msg.content as any;
      const extraDelay = await this.antiSpamService.checkAndThrottle(
        connectionId, msg.chatId, content.text?.length ?? 30,
      );
      if (extraDelay > 0) await new Promise((r) => setTimeout(r, extraDelay));

      // Send based on type
      switch (msg.type) {
        case 'text':
          await this.wahaService.sendText(
            worker.internalIp, worker.apiKeyEnc, wahaName,
            msg.chatId, content.text,
          );
          break;
        case 'image':
          await this.wahaService.sendImage(
            worker.internalIp, worker.apiKeyEnc, wahaName,
            msg.chatId, content.url, content.caption, content.data, content.mimetype,
          );
          break;
        case 'document':
          await this.wahaService.sendFile(
            worker.internalIp, worker.apiKeyEnc, wahaName,
            msg.chatId, content.url, content.filename, content.caption, content.data, content.mimetype,
          );
          break;
        case 'video':
          await this.wahaService.sendVideo(
            worker.internalIp, worker.apiKeyEnc, wahaName,
            msg.chatId, content.url, content.caption, content.data, content.mimetype,
          );
          break;
        case 'audio':
          await this.wahaService.sendVoice(
            worker.internalIp, worker.apiKeyEnc, wahaName,
            msg.chatId, content.url, content.data, content.mimetype,
          );
          break;
        default:
          throw new Error(`Unknown message type: ${msg.type}`);
      }

      // Mark as sent
      await this.db
        .update(messageQueue)
        .set({ status: 'sent', sentAt: new Date(), updatedAt: new Date() })
        .where(eq(messageQueue.id, messageId));

      this.logger.log(`Message ${messageId} sent successfully to ${msg.chatId} (${msg.label ?? msg.type})`);

    } catch (error) {
      const errMsg = error instanceof Error ? error.message : String(error);
      const newRetryCount = (msg.retryCount ?? 0) + 1;
      const failed = newRetryCount >= (msg.maxRetries ?? 3);

      this.logger.warn(`Message ${messageId} failed (attempt ${newRetryCount}/${msg.maxRetries}): ${errMsg}`);

      await this.db
        .update(messageQueue)
        .set({
          status: failed ? 'failed' : 'pending',
          retryCount: newRetryCount,
          lastError: errMsg.slice(0, 500),
          updatedAt: new Date(),
        })
        .where(eq(messageQueue.id, messageId));

      if (!failed) throw error; // let BullMQ retry
    }
  }
}
