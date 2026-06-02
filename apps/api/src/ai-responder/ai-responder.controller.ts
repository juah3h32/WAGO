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

    if (!sessions[0]) {
      throw new NotFoundException('Connection not found');
    }
    return sessions[0];
  }

  @Get()
  async getConfig(
    @Param('connectionId') connectionId: string,
    @CurrentUser() user: { id: string },
  ) {
    await this.assertConnectionOwnership(connectionId, user.id);
    const config = await this.aiResponderService.getConfig(connectionId, user.id);
    // Return empty default if not yet configured
    if (!config) {
      return {
        connectionId,
        enabled: false,
        provider: 'anthropic',
        model: 'claude-haiku-4-5-20251001',
        apiKey: null,
        systemPrompt: null,
        maxTokens: 500,
      };
    }
    // Mask the API key for security — only return whether it's set
    return {
      ...config,
      apiKey: config.apiKey ? '••••••••' : null,
      apiKeySet: !!config.apiKey,
    };
  }

  @Put()
  async upsertConfig(
    @Param('connectionId') connectionId: string,
    @CurrentUser() user: { id: string },
    @Body() dto: UpsertAiResponderDto,
  ) {
    await this.assertConnectionOwnership(connectionId, user.id);

    // If apiKey is the masked placeholder, don't overwrite
    if (dto.apiKey === '••••••••') {
      delete dto.apiKey;
    }

    const config = await this.aiResponderService.upsertConfig(connectionId, user.id, dto);
    return {
      ...config,
      apiKey: config.apiKey ? '••••••••' : null,
      apiKeySet: !!config.apiKey,
    };
  }

  @Post('test')
  async testConfig(
    @Param('connectionId') connectionId: string,
    @CurrentUser() user: { id: string },
  ) {
    await this.assertConnectionOwnership(connectionId, user.id);
    return this.aiResponderService.testConfig(connectionId, user.id);
  }
}
