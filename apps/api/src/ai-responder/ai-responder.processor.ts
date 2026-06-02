import { Processor, WorkerHost } from '@nestjs/bullmq';
import { Logger } from '@nestjs/common';
import { Job } from 'bullmq';
import { AiResponderService, AiResponderJobData } from './ai-responder.service';

@Processor('ai-response')
export class AiResponderProcessor extends WorkerHost {
  private readonly logger = new Logger(AiResponderProcessor.name);

  constructor(private readonly aiResponderService: AiResponderService) {
    super();
  }

  async process(job: Job<AiResponderJobData>): Promise<void> {
    if (job.name !== 'respond') {
      this.logger.warn(`Unknown job type: ${job.name}`);
      return;
    }

    this.logger.log(
      `Processing AI response job ${job.id} for connection ${job.data.connectionId}, chat ${job.data.chatId}`,
    );

    try {
      await this.aiResponderService.processIncomingMessage(job.data);
    } catch (err) {
      this.logger.error(
        `AI response job ${job.id} failed: ${err instanceof Error ? err.message : String(err)}`,
      );
      throw err; // rethrow so BullMQ can retry
    }
  }
}
