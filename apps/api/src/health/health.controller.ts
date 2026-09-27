import { Controller, Get, Res } from '@nestjs/common';
import { Response } from 'express';
import { PrismaService } from '../prisma/prisma.service';
import { RedisService } from '../redis/redis.service';

@Controller('health')
export class HealthController {
  constructor(
    private readonly prisma: PrismaService,
    private readonly redis: RedisService,
  ) {}

  @Get()
  async check(@Res({ passthrough: true }) res: Response) {
    let db = 'down';
    let redis = 'down';
    try {
      await this.prisma.$queryRaw`SELECT 1`;
      db = 'up';
    } catch {
      /* ignore */
    }
    try {
      const pong = await this.redis.client.ping();
      redis = pong === 'PONG' ? 'up' : 'down';
    } catch {
      /* ignore */
    }
    const ok = db === 'up' && redis === 'up';
    // 降级时返回 503，便于负载均衡/编排正确摘除实例
    if (!ok) res.status(503);
    return {
      status: ok ? 'ok' : 'degraded',
      db,
      redis,
      timestamp: new Date().toISOString(),
    };
  }
}
