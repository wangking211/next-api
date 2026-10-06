import { CanActivate, ExecutionContext, HttpException, Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { Request } from 'express';
import { RedisService } from '../redis/redis.service';

/**
 * 控制台 /api/** 的每 IP 全局限流（固定窗口，Redis INCR+EXPIRE 原子）。
 *
 * 背景：网关 /v1 有 per-key RPM/TPM，登录/注册/验证码各有 IP + 账号限流，
 * 但控制台其余端点（列表、导出、渠道测试…）对同一个 IP 完全不设防——
 * 单 IP 可以无限刷接口，既打爆 DB，也给撞库/爬数据开了口子。
 *
 * - 只管 /api/**：/v1 走 ApiKeyGuard 的 RPM/TPM，口径不同，两边互不重复计数。
 * - 按 req.ip 计数（trust proxy 已按 docker 网段配置，见 main.ts）；
 *   每个 IP 一个桶，窗口换桶，键带 TTL 不残留。
 * - Redis 不可用时放行（与网关限流同容错策略：可用性优先，限流是加分项）。
 * - 超限抛 { code: 'RATE_LIMITED' }：前端按 api.tooManyRequests 本地化，
 *   message 保留英文原文给 API 消费者/日志。
 * - CONSOLE_RATE_LIMIT=0 关闭（压测、内网批量脚本时用）。
 */
@Injectable()
export class ConsoleRateLimitGuard implements CanActivate {
  private readonly logger = new Logger(ConsoleRateLimitGuard.name);
  /** 每窗口每 IP 上限；0 = 关闭 */
  private readonly limit: number;
  /** 窗口秒数 */
  private readonly windowSec: number;

  constructor(
    private readonly redis: RedisService,
    config: ConfigService,
  ) {
    this.limit = Number(config.get<string>('CONSOLE_RATE_LIMIT', '600')) || 0;
    this.windowSec = Number(config.get<string>('CONSOLE_RATE_WINDOW', '60')) || 60;
  }

  async canActivate(context: ExecutionContext): Promise<boolean> {
    if (this.limit <= 0) return true;
    const req = context.switchToHttp().getRequest<Request>();
    const path = req.path ?? '';
    if (!path.startsWith('/api')) return true; // /v1 由 ApiKeyGuard 管，不重复计数

    const ip = (req.ip ?? req.socket?.remoteAddress ?? 'unknown').toString();
    const bucket = Math.floor(Date.now() / (this.windowSec * 1000));
    const key = `ratelimit:console:${ip}:${bucket}`;
    let count: number;
    try {
      // Lua 保证 INCR+EXPIRE 原子：中途失败也不会留下无 TTL 的永久计数键
      count = (await this.redis.client.eval(
        "local c = redis.call('INCR', KEYS[1]) if c == 1 then redis.call('EXPIRE', KEYS[1], ARGV[1]) end return c",
        1,
        key,
        this.windowSec + 5,
      )) as number;
    } catch (e) {
      this.logger.warn(`控制台限流检查失败（放行）: ${(e as Error)?.message}`);
      return true; // Redis 不可用时放行，不阻断控制台
    }

    if (count > this.limit) {
      throw new HttpException(
        {
          code: 'RATE_LIMITED',
          message: `Rate limit exceeded: ${this.limit} requests per ${this.windowSec}s`,
        },
        429,
      );
    }
    return true;
  }
}
