import { Module } from '@nestjs/common';
import { BullModule } from '@nestjs/bullmq';
import { AiResponderController } from './ai-responder.controller';
import { AiResponderService } from './ai-responder.service';
import { AiResponderProcessor } from './ai-responder.processor';

@Module({
  imports: [
    BullModule.registerQueue({
      name: 'ai-response',
      defaultJobOptions: {
        attempts: 2,
        backoff: {
          type: 'fixed',
          delay: 5000,
        },
        removeOnComplete: 100,
        removeOnFail: 500,
      },
    }),
  ],
  controllers: [AiResponderController],
  providers: [AiResponderService, AiResponderProcessor],
  exports: [BullModule],
})
export class AiResponderModule {}
