import { Module } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { BullModule } from '@nestjs/bullmq';
import { QueueController } from './queue.controller';
import { NotificationsController } from './notifications.controller';
import { QueueService } from './queue.service';
import { MessageQueueProcessor } from './message-queue.processor';

@Module({
  imports: [
    BullModule.forRootAsync({
      inject: [ConfigService],
      useFactory: (config: ConfigService) => {
        const redisUrl = config.get<string>('REDIS_URL', 'redis://localhost:6379');
        const url = new URL(redisUrl);
        return {
          connection: {
            host: url.hostname,
            port: parseInt(url.port || '6379'),
            password: url.password || undefined,
            tls: url.protocol === 'rediss:' ? {} : undefined,
            enableReadyCheck: false,
            maxRetriesPerRequest: null,
            lazyConnect: true,
          },
        };
      },
    }),
    BullModule.registerQueue({
      name: 'message-queue',
      defaultJobOptions: {
        attempts: 5,
        backoff: { type: 'exponential', delay: 10_000 },
        removeOnComplete: 50,
        removeOnFail: 200,
      },
    }),
  ],
  controllers: [QueueController, NotificationsController],
  providers: [QueueService, MessageQueueProcessor],
  exports: [QueueService],
})
export class QueueModule {}
