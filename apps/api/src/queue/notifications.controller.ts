import { Controller, Post, Body, Headers, UnauthorizedException, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { QueueService } from './queue.service';

/**
 * Internal notification webhook — called by your app/bot when events happen.
 * Protected by a shared secret in the X-Notify-Secret header.
 *
 * Example: when a user registers on your site, POST to /api/notifications/trigger
 * and it will queue a WhatsApp message to your admin number, even if the Mac is off.
 */
@Controller('notifications')
export class NotificationsController {
  private readonly logger = new Logger(NotificationsController.name);

  constructor(
    private readonly queueService: QueueService,
    private readonly configService: ConfigService,
  ) {}

  @Post('trigger')
  async trigger(
    @Headers('x-notify-secret') secret: string,
    @Body() body: {
      userId: string;           // Wago user who owns the WhatsApp connection
      connectionId?: string;    // specific connection, or auto-pick active one
      chatId: string;           // WhatsApp recipient (e.g. your admin number: 5211234567890@c.us)
      message: string;          // Message text
      label?: string;           // Description for the queue log (e.g. "new_registration")
      scheduledAt?: string;     // ISO 8601 — omit for immediate
    },
  ) {
    const expectedSecret = this.configService.get<string>('NOTIFY_SECRET');
    if (!expectedSecret || secret !== expectedSecret) {
      throw new UnauthorizedException('Invalid notification secret');
    }

    const queued = await this.queueService.createMessage(body.userId, {
      connectionId: body.connectionId ?? '',
      chatId: body.chatId,
      type: 'text',
      content: { text: body.message },
      label: body.label ?? 'notification',
      scheduledAt: body.scheduledAt,
      maxRetries: 5,
    });

    this.logger.log(`Notification queued: ${queued.id} — ${body.label ?? 'trigger'} → ${body.chatId}`);
    return { queued: true, id: queued.id };
  }
}
