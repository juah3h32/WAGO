import { Controller, Post, Get, Delete, Param, Body, Query, UseGuards } from '@nestjs/common';
import { AuthGuard } from '../auth/auth.guard';
import { CurrentUser } from '../auth/user.decorator';
import { QueueService } from './queue.service';
import { CreateQueuedMessageDto } from './queue.dto';

@Controller('queue')
@UseGuards(AuthGuard)
export class QueueController {
  constructor(private readonly queueService: QueueService) {}

  /**
   * Queue a message to be sent via WhatsApp.
   * If the connection is offline or the Mac is off, it will be sent when they come back online.
   *
   * Body examples:
   *   { connectionId, chatId, content: { text: "Hola!" } }
   *   { connectionId, chatId, type: "image", content: { url: "https://...", caption: "foto" } }
   *   { connectionId, chatId, scheduledAt: "2026-06-01T10:00:00Z", content: { text: "Recordatorio" } }
   */
  @Post('messages')
  async createMessage(
    @Body() dto: CreateQueuedMessageDto,
    @CurrentUser() user: { sub: string },
  ) {
    return this.queueService.createMessage(user.sub, dto);
  }

  /**
   * List queued messages.
   * ?status=pending|processing|sent|failed|cancelled
   */
  @Get('messages')
  async listMessages(
    @CurrentUser() user: { sub: string },
    @Query('status') status?: string,
  ) {
    return this.queueService.listMessages(user.sub, status);
  }

  /**
   * Cancel a pending message before it is sent.
   */
  @Delete('messages/:id')
  async cancelMessage(
    @Param('id') id: string,
    @CurrentUser() user: { sub: string },
  ) {
    await this.queueService.cancelMessage(user.sub, id);
    return { cancelled: true };
  }
}
