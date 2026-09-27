import { HttpException, Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { RedisService } from '../redis/redis.service';
import { openaiError } from './types';

@Injectable()
export class RateLimiterService {
  private readonly logger = new Logger(RateLimiterService.name);
  private readonly defaultRpm: number;

  constructor(
    private readonly redis: RedisService,
    config: ConfigService,
  ) {
    this.defaultRpm = Number(config.get<string>('DEFAULT_RPM', '0')) || 0;
  }

  /** 固定窗口限流：每分钟每 key 的请求数上限。0/未设置表示不限制。 */
  async check(apiKeyId: string, rpmLimit: number | null): Promise<void> {
    const limit = rpmLimit ?? this.defaultRpm;
    if (!limit || limit <= 0) return;

    const bucket = Math.floor(Date.now() / 60000);
    const key = `ratelimit:key:${apiKeyId}:${bucket}`;
    let count: number;
    try {
      // Lua 脚本保证 INCR+EXPIRE 原子，避免中途失败留下无 TTL 的永久计数键
      count = (await this.redis.client.eval(
        "local c = redis.call('INCR', KEYS[1]) if c == 1 then redis.call('EXPIRE', KEYS[1], ARGV[1]) end return c",
        1,
        key,
        65,
      )) as number;
    } catch (e) {
      this.logger.warn(`限流检查失败（放行）: ${(e as Error)?.message}`);
      return; // Redis 不可用时放行，不阻断主流程
    }

    if (count > limit) {
      throw new HttpException(
        openaiError(
          `Rate limit exceeded: ${limit} requests per minute`,
          'rate_limit_error',
          'rate_limit_exceeded',
        ),
        429,
      );
    }
  }
}
