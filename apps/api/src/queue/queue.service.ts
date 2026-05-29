import { Injectable, Logger, Inject, OnModuleInit } from '@nestjs/common';
import { InjectQueue } from '@nestjs/bullmq';
import { Queue } from 'bullmq';
import { eq, and, or, lte } from 'drizzle-orm';
import { messageQueue } from '@wago/db';
import { DRIZZLE_TOKEN } from '../database/database.module';
import { CreateQueuedMessageDto } from './queue.dto';

@Injectable()
export class QueueService implements OnModuleInit {
  private readonly logger = new Logger(QueueService.name);

  constructor(
    @Inject(DRIZZLE_TOKEN) private readonly db: any,
    @InjectQueue('message-queue') private readonly queue: Queue,
  ) {}

  /**
   * On startup, recover all pending/processing messages from DB and re-enqueue them.
   * This handles the case where the Mac was off and messages were never sent.
   */
  async onModuleInit(): Promise<void> {
    try {
      const now = new Date();
      const pending = await this.db
        .select()
        .from(messageQueue)
        .where(
          and(
            or(
              eq(messageQueue.status, 'pending'),
              eq(messageQueue.status, 'processing'), // stuck from previous crash
            ),
            or(
              lte(messageQueue.scheduledAt, now),
              eq(messageQueue.scheduledAt, null as any),
            ),
          ),
        );

      if (pending.length > 0) {
        this.logger.log(`Recovering ${pending.length} pending messages from DB on startup`);
        for (const msg of pending) {
          await this.enqueue(msg.id, msg.scheduledAt);
        }
      }
    } catch (err) {
      this.logger.error(`Failed to recover pending messages: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  /**
   * Create and enqueue a message. If the Mac is off when this is called via API,
   * the message is saved to DB and recovered on next startup.
   */
  async createMessage(userId: string, dto: CreateQueuedMessageDto): Promise<any> {
    const [inserted] = await this.db
      .insert(messageQueue)
      .values({
        userId,
        connectionId: dto.connectionId ?? null,
        chatId: dto.chatId,
        type: dto.type ?? 'text',
        content: dto.content,
        status: 'pending',
        scheduledAt: dto.scheduledAt ? new Date(dto.scheduledAt) : null,
        label: dto.label ?? null,
        maxRetries: dto.maxRetries ?? 3,
      })
      .returning();

    await this.enqueue(inserted.id, inserted.scheduledAt);
    this.logger.log(`Queued message ${inserted.id} for ${inserted.chatId} (${inserted.label ?? inserted.type})`);
    return inserted;
  }

  async listMessages(userId: string, status?: string): Promise<any[]> {
    const conditions = [eq(messageQueue.userId, userId)];
    if (status) conditions.push(eq(messageQueue.status, status as any));
    return this.db.select().from(messageQueue).where(and(...conditions));
  }

  async cancelMessage(userId: string, messageId: string): Promise<void> {
    const [msg] = await this.db
      .select()
      .from(messageQueue)
      .where(and(eq(messageQueue.id, messageId), eq(messageQueue.userId, userId)));

    if (!msg || msg.status === 'sent') return;

    await this.db
      .update(messageQueue)
      .set({ status: 'cancelled', updatedAt: new Date() })
      .where(eq(messageQueue.id, messageId));

    // Remove from BullMQ queue if still waiting
    try {
      const job = await this.queue.getJob(messageId);
      if (job) await job.remove();
    } catch { /* job may not exist */ }
  }

  private async enqueue(messageId: string, scheduledAt?: Date | null): Promise<void> {
    const delay = scheduledAt ? Math.max(0, scheduledAt.getTime() - Date.now()) : 0;
    await this.queue.add(
      'send',
      { messageId },
      {
        jobId: messageId, // idempotent — prevents duplicate jobs
        delay,
        attempts: 5,
        backoff: { type: 'exponential', delay: 10_000 }, // 10s, 20s, 40s…
        removeOnComplete: 50,
        removeOnFail: 200,
      },
    );
  }
}
