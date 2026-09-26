import { HttpException, Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { RedisService } from '../redis/redis.service';
import { openaiError } from './types';

@Injectable()
export class RateLimiterService {
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
      count = await this.redis.client.incr(key);
      if (count === 1) await this.redis.client.expire(key, 65);
    } catch {
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
