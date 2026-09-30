import {
  Controller,
  ForbiddenException,
  Get,
  Req,
  Res,
  UnauthorizedException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { timingSafeEqual } from 'crypto';
import type { Request, Response } from 'express';
import { MetricsService } from './metrics.service';

/** 定长比较防时序侧信道；长度不等直接失败 */
function tokenMatches(provided: string, expected: string): boolean {
  const a = Buffer.from(provided);
  const b = Buffer.from(expected);
  return a.length === b.length && a.length > 0 && timingSafeEqual(a, b);
}

/**
 * Prometheus 抓取端点 GET /api/metrics（text/plain; version=0.0.4）。
 *
 * - METRICS_TOKEN 已设置：要求 `Authorization: Bearer <token>` 或 `X-Metrics-Token` 头
 * - 未设置：非生产开放；生产返回 403（与 Swagger 生产默认关闭同一思路，
 *   防止把内部路由结构、流量与进程信息暴露在公网）
 */
@Controller('metrics')
export class MetricsController {
  private readonly token: string;
  private readonly isProd: boolean;

  constructor(
    config: ConfigService,
    private readonly metrics: MetricsService,
  ) {
    this.token = (config.get<string>('METRICS_TOKEN', '') ?? '').trim();
    this.isProd = config.get<string>('NODE_ENV') === 'production';
  }

  @Get()
  async scrape(
    @Req() req: Request,
    @Res({ passthrough: true }) res: Response,
  ): Promise<string> {
    if (this.token) {
      const auth = req.header('authorization') ?? '';
      const bearer = auth.startsWith('Bearer ') ? auth.slice(7) : '';
      const provided = bearer || (req.header('x-metrics-token') ?? '');
      if (!tokenMatches(provided, this.token)) {
        throw new UnauthorizedException('invalid metrics token');
      }
    } else if (this.isProd) {
      throw new ForbiddenException('metrics disabled: set METRICS_TOKEN to enable it');
    }
    res.setHeader('content-type', 'text/plain; version=0.0.4; charset=utf-8');
    return this.metrics.render();
  }
}
