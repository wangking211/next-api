import { Controller, Get, Param, Query, Res, UseGuards } from '@nestjs/common';
import { Response } from 'express';
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

  private scope(
    user: AuthUser,
    scope?: string,
    targetUserId?: string,
  ): string | null {
    if (user.role !== Role.ADMIN) return user.id;
    if (targetUserId) return targetUserId;
    if (scope === 'all') return null;
    return user.id;
  }

  @Get('summary')
  summary(
    @CurrentUser() user: AuthUser,
    @Query('days') days?: string,
    @Query('scope') scope?: string,
    @Query('userId') userId?: string,
  ) {
    return this.usage.summary(this.scope(user, scope, userId), toInt(days, 30));
  }

  @Get('daily')
  daily(
    @CurrentUser() user: AuthUser,
    @Query('days') days?: string,
    @Query('scope') scope?: string,
    @Query('userId') userId?: string,
  ) {
    return this.usage.daily(this.scope(user, scope, userId), toInt(days, 30));
  }

  @Get('analytics')
  analytics(
    @CurrentUser() user: AuthUser,
    @Query('days') days?: string,
    @Query('scope') scope?: string,
    @Query('userId') userId?: string,
    @Query('from') from?: string,
    @Query('to') to?: string,
  ) {
    return this.usage.analytics(this.scope(user, scope, userId), toInt(days, 30), {
      from: from || undefined,
      to: to || undefined,
    });
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
      model: model || undefined,
      status: status === 'success' || status === 'error' ? status : undefined,
      stream: stream === 'true' ? true : stream === 'false' ? false : undefined,
      q: q || undefined,
      from: from || undefined,
      to: to || undefined,
    };
    // targetUserId 必须交由 scope() 解析（非管理员一律忽略），
    // 不能塞进 query 覆盖属主过滤，否则会跨租户读取他人日志。
    return this.usage.logs(this.scope(user, scope, targetUserId), query);
  }

  @Get('logs/export')
  async exportLogs(
    @CurrentUser() user: AuthUser,
    @Res() res: Response,
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
      apiKeyId: apiKeyId || undefined,
      channelId: channelId || undefined,
      model: model || undefined,
      status: status === 'success' || status === 'error' ? status : undefined,
      stream: stream === 'true' ? true : stream === 'false' ? false : undefined,
      q: q || undefined,
      from: from || undefined,
      to: to || undefined,
    };
    const csv = await this.usage.exportLogs(
      this.scope(user, scope, targetUserId),
      query,
    );
    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', 'attachment; filename="request-logs.csv"');
    res.send('\uFEFF' + csv);
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
