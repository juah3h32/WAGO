import {
  Controller,
  Get,
  Put,
  Post,
  Param,
  Body,
  UseGuards,
  Logger,
  NotFoundException,
  Inject,
} from '@nestjs/common';
import { eq, and, not } from 'drizzle-orm';
import { wahaSessions } from '@wago/db';
import { AuthGuard } from '../auth/auth.guard';
import { CurrentUser } from '../auth/user.decorator';
import { DRIZZLE_TOKEN } from '../database/database.module';
import { AiResponderService, UpsertAiResponderDto } from './ai-responder.service';

const MASKED = '••••••••';

@Controller('connections/:connectionId/ai-responder')
@UseGuards(AuthGuard)
export class AiResponderController {
  private readonly logger = new Logger(AiResponderController.name);

  constructor(
    @Inject(DRIZZLE_TOKEN) private readonly db: any,
    private readonly aiResponderService: AiResponderService,
  ) {}

  private async assertConnectionOwnership(connectionId: string, userId: string) {
    const sessions = await this.db
      .select()
      .from(wahaSessions)
      .where(
        and(
          eq(wahaSessions.id, connectionId),
          eq(wahaSessions.userId, userId),
          not(eq(wahaSessions.status, 'stopped')),
        ),
      )
      .limit(1);

    if (!sessions[0]) throw new NotFoundException('Connection not found');
    return sessions[0];
  }

  /** Never expose the raw API key — only tell the client whether one is set. */
  private sanitize(config: any) {
    const { apiKey, ...rest } = config;
    return { ...rest, apiKeySet: !!apiKey, apiKey: apiKey ? MASKED : null };
  }

  @Get()
  async getConfig(
    @Param('connectionId') connectionId: string,
    @CurrentUser() user: { sub: string },
  ) {
    await this.assertConnectionOwnership(connectionId, user.sub);
    const config = await this.aiResponderService.getConfig(connectionId, user.sub);
    if (!config) {
      return {
        connectionId, enabled: false, provider: 'anthropic',
        model: 'claude-haiku-4-5-20251001', apiKey: null,
        apiKeySet: false, systemPrompt: null, maxTokens: 500,
      };
    }
    return this.sanitize(config);
  }

  @Put()
  async upsertConfig(
    @Param('connectionId') connectionId: string,
    @CurrentUser() user: { sub: string },
    @Body() dto: UpsertAiResponderDto,
  ) {
    await this.assertConnectionOwnership(connectionId, user.sub);

    // If frontend sent the masked placeholder, keep the existing key
    if (dto.apiKey === MASKED || dto.apiKey === '') {
      delete dto.apiKey;
    }

    const config = await this.aiResponderService.upsertConfig(connectionId, user.sub, dto);
    return this.sanitize(config);
  }

  @Post('test')
  async testConfig(
    @Param('connectionId') connectionId: string,
    @CurrentUser() user: { sub: string },
  ) {
    await this.assertConnectionOwnership(connectionId, user.sub);
    return this.aiResponderService.testConfig(connectionId, user.sub);
  }
}
