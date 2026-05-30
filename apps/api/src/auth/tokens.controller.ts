import {
  Controller,
  Get,
  Post,
  Delete,
  Param,
  Body,
  Inject,
  UseGuards,
  NotFoundException,
  ForbiddenException,
  BadRequestException,
} from '@nestjs/common';
import { randomBytes, createHash } from 'crypto';
import { eq, and } from 'drizzle-orm';
import { apiTokens, wahaSessions } from '@wago/db';
import { AuthGuard } from './auth.guard';
import { CurrentUser } from './user.decorator';
import { DRIZZLE_TOKEN } from '../database/database.module';

@Controller('tokens')
@UseGuards(AuthGuard)
export class TokensController {
  constructor(@Inject(DRIZZLE_TOKEN) private readonly db: any) {}

  @Get()
  async listTokens(@CurrentUser() user: { sub: string }) {
    const tokens = await this.db
      .select({
        id: apiTokens.id,
        name: apiTokens.name,
        connectionId: apiTokens.connectionId,
        tokenPrefix: apiTokens.tokenPrefix,
        active: apiTokens.active,
        lastUsedAt: apiTokens.lastUsedAt,
        createdAt: apiTokens.createdAt,
      })
      .from(apiTokens)
      .where(
        and(
          eq(apiTokens.userId, user.sub),
          eq(apiTokens.active, true),
        ),
      );

    return tokens;
  }

  @Post()
  async createToken(
    @Body() body: { name: string; connectionId?: string },
    @CurrentUser() user: { sub: string },
  ) {
    if (body.connectionId) {
      const [conn] = await this.db
        .select({ id: wahaSessions.id, userId: wahaSessions.userId })
        .from(wahaSessions)
        .where(eq(wahaSessions.id, body.connectionId));

      if (!conn) {
        throw new NotFoundException('Connection not found');
      }
      if (conn.userId !== user.sub) {
        throw new ForbiddenException('You do not own this connection');
      }
    }

    const rawToken = `wh_${randomBytes(24).toString('hex')}`;
    const tokenHash = createHash('sha256').update(rawToken).digest('hex');
    const tokenPrefix = rawToken.slice(0, 10) + '...';

    const [created] = await this.db
      .insert(apiTokens)
      .values({
        userId: user.sub,
        connectionId: body.connectionId ?? null,
        name: body.name,
        tokenHash,
        tokenPrefix,
      })
      .returning();

    return {
      id: created.id,
      name: created.name,
      connectionId: created.connectionId,
      token: rawToken,
      tokenPrefix,
      createdAt: created.createdAt,
    };
  }

  @Delete(':id')
  async revokeToken(
    @Param('id') id: string,
    @CurrentUser() user: { sub: string },
  ) {
    const [token] = await this.db
      .select()
      .from(apiTokens)
      .where(eq(apiTokens.id, id));

    if (!token) {
      throw new NotFoundException('Token not found');
    }

    if (token.userId !== user.sub) {
      throw new ForbiddenException('You do not own this token');
    }

    await this.db
      .update(apiTokens)
      .set({ active: false })
      .where(eq(apiTokens.id, id));

    return { success: true };
  }
}
