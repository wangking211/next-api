import { BadRequestException, Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { RedisService } from '../redis/redis.service';

/** 合理区间校验：防止上游返回垃圾数据导致充值比例异常 */
const MIN_RATE = 2;
const MAX_RATE = 20;
/** 进程内缓存时长（降低公开配置接口与下单的对外请求频率） */
const MEMO_MS = 60_000;

/**
 * 美元兑人民币汇率（在线充值用）。
 * 取值优先级：`PAY_CNY_PER_USD` 固定值 > Redis 缓存 > 实时汇率接口 > 上次已知值（接口故障兜底）。
 * 实时接口默认 exchangerate-api 免费端点（无需密钥），可用 `PAY_RATE_API_URL` 替换为任意返回 `rates.CNY` 的接口。
 */
@Injectable()
export class ExchangeRateService {
  private readonly logger = new Logger(ExchangeRateService.name);
  private static readonly CACHE_KEY = 'pay:fx:usd_cny';
  private static readonly LAST_KEY = 'pay:fx:usd_cny:last';

  private memo: { rate: number; at: number } | null = null;
  private inflight: Promise<number> | null = null;

  constructor(
    private readonly config: ConfigService,
    private readonly redis: RedisService,
  ) {}

  /** 手动固定汇率（env `PAY_CNY_PER_USD`）；未配置或非法返回 null */
  manualRate(): number | null {
    const raw = (this.config.get<string>('PAY_CNY_PER_USD', '') ?? '').trim();
    if (!raw) return null;
    const n = Number(raw);
    if (!Number.isFinite(n) || n < MIN_RATE || n > MAX_RATE) {
      this.logger.warn(`PAY_CNY_PER_USD=${raw} 不在合理区间（${MIN_RATE}~${MAX_RATE}），忽略`);
      return null;
    }
    return n;
  }

  /** 1 美元 = ? 元人民币 */
  async getCnyPerUsd(): Promise<number> {
    const manual = this.manualRate();
    if (manual) return manual;

    if (this.memo && Date.now() - this.memo.at < MEMO_MS) return this.memo.rate;

    const cached = await this.redisGet(ExchangeRateService.CACHE_KEY);
    if (cached) {
      this.remember(cached);
      return cached;
    }

    if (!this.inflight) {
      this.inflight = this.fetchLive().finally(() => {
        this.inflight = null;
      });
    }
    const rate = await this.inflight;
    this.remember(rate);
    return rate;
  }

  private remember(rate: number) {
    this.memo = { rate, at: Date.now() };
  }

  private async fetchLive(): Promise<number> {
    const url =
      this.config.get<string>('PAY_RATE_API_URL', '') || 'https://open.er-api.com/v6/latest/USD';
    const timeout = Number(this.config.get<string>('PAY_RATE_TIMEOUT_MS', '5000')) || 5000;
    const ttl = Number(this.config.get<string>('PAY_RATE_TTL_MS', '')) || 6 * 3600 * 1000;

    try {
      const res = await fetch(url, {
        headers: { accept: 'application/json' },
        signal: AbortSignal.timeout(timeout),
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const json: any = await res.json();
      const rate = Number(json?.rates?.CNY);
      if (!Number.isFinite(rate) || rate < MIN_RATE || rate > MAX_RATE) {
        throw new Error(`汇率数据异常: ${JSON.stringify(json?.rates?.CNY)}`);
      }
      await this.redisSet(ExchangeRateService.CACHE_KEY, rate, ttl);
      await this.redisSet(ExchangeRateService.LAST_KEY, rate);
      this.logger.log(`实时汇率 1 USD = ${rate} CNY（缓存 ${Math.round(ttl / 60000)} 分钟）`);
      return rate;
    } catch (e) {
      const reason = e instanceof Error ? e.message : String(e);
      const last = await this.redisGet(ExchangeRateService.LAST_KEY);
      if (last) {
        this.logger.warn(`实时汇率获取失败（${reason}），沿用上次已知汇率 ${last}`);
        return last;
      }
      this.logger.error(`实时汇率获取失败且无历史值: ${reason}`);
      throw new BadRequestException({
        code: 'BILLING_EXCHANGE_RATE_UNAVAILABLE',
        message: '实时汇率获取失败，请稍后重试或由管理员配置固定汇率',
      });
    }
  }

  private async redisGet(key: string): Promise<number | null> {
    try {
      const raw = await this.redis.client.get(key);
      const n = Number(raw);
      return raw && Number.isFinite(n) && n >= MIN_RATE && n <= MAX_RATE ? n : null;
    } catch {
      return null; // Redis 不可用不阻塞下单
    }
  }

  private async redisSet(key: string, rate: number, ttlMs?: number) {
    try {
      if (ttlMs && ttlMs > 0) {
        await this.redis.client.set(key, String(rate), 'PX', Math.round(ttlMs));
      } else {
        await this.redis.client.set(key, String(rate));
      }
    } catch {
      /* Redis 不可用不影响流程 */
    }
  }
}
