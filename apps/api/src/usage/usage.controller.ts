import { Controller, Get, Param, Query, UseGuards } from '@nestjs/common';
import { Role } from '@prisma/client';
import { UsageService, LogQuery } from './usage.service';
import { JwtAuthGuard } from '../common/guards/jwt-auth.guard';
import { CurrentUser } from '../common/decorators/current-user.decorator';
import { AuthUser } from '../common/interfaces/auth.interface';

function toInt(value: string | undefined, fallback: number): number {
  const n = Number(value);
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : fallback;
}

@UseGuards(JwtAuthGuard)
@Controller('usage')
export class UsageController {
  constructor(private readonly usage: UsageService) {}

  private scope(user: AuthUser, scope?: string): string | null {
    if (scope === 'all' && user.role === Role.ADMIN) return null;
    return user.id;
  }

  @Get('summary')
  summary(
    @CurrentUser() user: AuthUser,
    @Query('days') days?: string,
    @Query('scope') scope?: string,
  ) {
    return this.usage.summary(this.scope(user, scope), toInt(days, 30));
  }

  @Get('daily')
  daily(
    @CurrentUser() user: AuthUser,
    @Query('days') days?: string,
    @Query('scope') scope?: string,
  ) {
    return this.usage.daily(this.scope(user, scope), toInt(days, 30));
  }

  @Get('analytics')
  analytics(
    @CurrentUser() user: AuthUser,
    @Query('days') days?: string,
    @Query('scope') scope?: string,
  ) {
    return this.usage.analytics(this.scope(user, scope), toInt(days, 30));
  }

  @Get('logs')
  logs(
    @CurrentUser() user: AuthUser,
    @Query('page') page?: string,
    @Query('pageSize') pageSize?: string,
    @Query('scope') scope?: string,
    @Query('apiKeyId') apiKeyId?: string,
    @Query('channelId') channelId?: string,
    @Query('userId') targetUserId?: string,
    @Query('model') model?: string,
    @Query('status') status?: string,
    @Query('stream') stream?: string,
    @Query('q') q?: string,
    @Query('from') from?: string,
    @Query('to') to?: string,
  ) {
    const query: LogQuery = {
      page: toInt(page, 1),
      pageSize: Math.min(toInt(pageSize, 20), 100),
      apiKeyId: apiKeyId || undefined,
      channelId: channelId || undefined,
      targetUserId: targetUserId || undefined,
      model: model || undefined,
      status: status === 'success' || status === 'error' ? status : undefined,
      stream: stream === 'true' ? true : stream === 'false' ? false : undefined,
      q: q || undefined,
      from: from || undefined,
      to: to || undefined,
    };
    return this.usage.logs(this.scope(user, scope), query);
  }

  @Get('logs/:id')
  detail(
    @CurrentUser() user: AuthUser,
    @Param('id') id: string,
    @Query('scope') scope?: string,
  ) {
    return this.usage.detail(this.scope(user, scope), id);
  }
}
