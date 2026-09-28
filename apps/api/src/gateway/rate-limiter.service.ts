import { HttpException, Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { RedisService } from '../redis/redis.service';
import { openaiError } from './types';
import { toAnthropicErrorBody } from './anthropic-format';

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

  /** 按客户端协议组装错误体（openai / anthropic），guard 与限流共用 */
  private errorBody(
    apiFormat: 'openai' | 'anthropic' | undefined,
    message: string,
    type: string,
    code: string | null,
  ): { error?: unknown; type?: string } {
    return apiFormat === 'anthropic'
      ? toAnthropicErrorBody(message, type)
      : openaiError(message, type, code);
  }

  /** 固定窗口限流：每分钟每 key 的请求数上限。0/未设置表示不限制。 */
  async check(
    apiKeyId: string,
    rpmLimit: number | null,
    apiFormat?: 'openai' | 'anthropic',
  ): Promise<void> {
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
        this.errorBody(
          apiFormat,
          `Rate limit exceeded: ${limit} requests per minute`,
          'rate_limit_error',
          'rate_limit_exceeded',
        ),
        429,
      );
    }
  }

  /**
   * TPM 固定窗口预扣：按预估 token 数原子 INCRBY，超限回滚（DECRBY 回原值）并抛 429。
   * 返回命中的窗口桶号（供事后 adjustTpm 定位同一桶）；无限制/预估为 0/Redis 故障返回 null（fail-open）。
   */
  async checkTpm(
    apiKeyId: string,
    tpmLimit: number | null,
    estimatedTokens: number,
    apiFormat?: 'openai' | 'anthropic',
  ): Promise<number | null> {
    if (!tpmLimit || tpmLimit <= 0 || estimatedTokens <= 0) return null;

    const bucket = Math.floor(Date.now() / 60000);
    const key = `ratelimit:tpm:${apiKeyId}:${bucket}`;
    let count: number;
    try {
      // INCRBY 预估；若超限先回滚再返回 -1（单脚本原子，避免其他请求看到超限计数）
      count = (await this.redis.client.eval(
        `local c = redis.call('INCRBY', KEYS[1], ARGV[1])
         if c == tonumber(ARGV[1]) then redis.call('EXPIRE', KEYS[1], 65) end
         if c > tonumber(ARGV[2]) then
           redis.call('DECRBY', KEYS[1], ARGV[1])
           return -1
         end
         return c`,
        1,
        key,
        estimatedTokens,
        tpmLimit,
      )) as number;
    } catch (e) {
      this.logger.warn(`TPM 限流检查失败（放行）: ${(e as Error)?.message}`);
      return null; // Redis 不可用时放行
    }

    if (count < 0) {
      throw new HttpException(
        this.errorBody(
          apiFormat,
          `Rate limit exceeded: ${tpmLimit} tokens per minute`,
          'rate_limit_error',
          'tokens_per_minute_exceeded',
        ),
        429,
      );
    }
    return bucket;
  }

  /**
   * TPM 事后校正：对预扣时的同一窗口桶回补 delta = 实际 − 预估（可为负）。
   * 结果 clamp 到 ≥0，窗口键不存在时创建并设 TTL。失败仅告警不抛错。
   */
  async adjustTpm(apiKeyId: string, bucket: number, delta: number): Promise<void> {
    if (!delta) return;
    const key = `ratelimit:tpm:${apiKeyId}:${bucket}`;
    try {
      await this.redis.client.eval(
        `local c = redis.call('INCRBY', KEYS[1], ARGV[1])
         if c < 0 then redis.call('SET', KEYS[1], 0) c = 0 end
         if redis.call('TTL', KEYS[1]) < 0 then redis.call('EXPIRE', KEYS[1], 65) end
         return c`,
        1,
        key,
        delta,
      );
    } catch (e) {
      this.logger.warn(`TPM 校正失败（忽略）: ${(e as Error)?.message}`);
    }
  }
}
