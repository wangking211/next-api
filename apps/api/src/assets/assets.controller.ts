import {
  BadRequestException,
  Controller,
  Delete,
  ForbiddenException,
  Get,
  Param,
  Post,
  Query,
  Res,
  UseGuards,
} from '@nestjs/common';
import type { Response } from 'express';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { Role } from '@prisma/client';
import { AssetsService } from './assets.service';
import { JwtAuthGuard } from '../common/guards/jwt-auth.guard';
import { CurrentUser } from '../common/decorators/current-user.decorator';
import { AuthUser } from '../common/interfaces/auth.interface';

function toInt(value: string | undefined, fallback: number): number {
  const n = Number(value);
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : fallback;
}

/**
 * 制成品（视频/图片）管理。
 * 权限与调用日志一致：普通用户只看自己的；管理员可加 `scope=all` 看全量。
 */
@UseGuards(JwtAuthGuard)
@Controller('assets')
export class AssetsController {
  constructor(private readonly assets: AssetsService) {}

  private scope(user: AuthUser, scope?: string, targetUserId?: string): string | null {
    if (user.role !== Role.ADMIN) return user.id;
    if (targetUserId) return targetUserId;
    if (scope === 'all') return null;
    return user.id;
  }

  @Get()
  list(
    @CurrentUser() user: AuthUser,
    @Query('page') page?: string,
    @Query('pageSize') pageSize?: string,
    @Query('kind') kind?: string,
    @Query('status') status?: string,
    @Query('model') model?: string,
    @Query('scope') scope?: string,
    @Query('userId') userId?: string,
  ) {
    return this.assets.list(this.scope(user, scope, userId), {
      page: toInt(page, 1),
      pageSize: toInt(pageSize, 24),
      kind: kind || undefined,
      status: status || undefined,
      model: model || undefined,
      userId: userId || undefined,
    });
  }

  @Get(':id')
  detail(@CurrentUser() user: AuthUser, @Param('id') id: string) {
    return this.assets.detail(this.scope(user), id);
  }

  /** 预签名下载地址（私有桶，过期时间见响应） */
  @Get(':id/url')
  url(@CurrentUser() user: AuthUser, @Param('id') id: string) {
    return this.assets.downloadUrl(this.scope(user), id);
  }

  /**
   * 网关代理下载：带 Content-Disposition 直接落盘。
   * 走网关而不是让浏览器直连 COS，避免跨域与跨域 `download` 失效。
   */
  @Get(':id/content')
  async content(@CurrentUser() user: AuthUser, @Param('id') id: string, @Res() res: Response) {
    const meta = await this.assets.contentMeta(this.scope(user), id);
    const upstream = await fetch(meta.url);
    if (!upstream.ok || !upstream.body) {
      throw new BadRequestException({
        code: 'ASSET_FETCH_FAILED',
        message: `Object storage responded ${upstream.status}`,
      });
    }
    res.setHeader('Content-Type', meta.contentType);
    res.setHeader('Content-Disposition', `attachment; filename="${meta.filename}"`);
    if (meta.bytes && meta.bytes > 0) res.setHeader('Content-Length', String(meta.bytes));
    await pipeline(Readable.fromWeb(upstream.body as Parameters<typeof Readable.fromWeb>[0]), res);
  }

  /** 重新抓取：上游就绪但当时抓取失败时用 */
  @Post(':id/retry')
  retry(@CurrentUser() user: AuthUser, @Param('id') id: string) {
    return this.assets.retry(this.scope(user), id);
  }

  @Delete(':id')
  remove(@CurrentUser() user: AuthUser, @Param('id') id: string) {
    return this.assets.remove(this.scope(user), id);
  }

  /**
   * 一键清空：删除 COS 前缀下全部对象 + 清空成品记录。仅管理员，不可恢复。
   * 需要显式传 `confirm=DELETE_ALL`，避免误触。
   */
  @Post('purge')
  purge(@CurrentUser() user: AuthUser, @Query('confirm') confirm?: string) {
    if (user.role !== Role.ADMIN)
      throw new ForbiddenException({ code: 'ASSET_ADMIN_ONLY', message: 'Admin only' });
    if (confirm !== 'DELETE_ALL') {
      throw new ForbiddenException({
        code: 'ASSET_PURGE_CONFIRM_REQUIRED',
        message: 'Missing confirm=DELETE_ALL',
      });
    }
    return this.assets.purgeAll();
  }
}
