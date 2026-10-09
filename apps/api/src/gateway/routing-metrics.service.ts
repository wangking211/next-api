import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { RedisService } from '../redis/redis.service';

/** 一次上游调用的结果类型（供指标记录） */
export type RouteOutcome = 'ok' | 'error' | 'rate_limited' | 'refused' | 'model_denied';

export interface RouteRecordArgs {
  latencyMs: number;
  completionTokens?: number;
  /** prompt+completion，用于渠道每日 token 限额计数 */
  totalTokens?: number;
  status?: number;
  errorMessage?: string | null;
  /** 上游 Retry-After（毫秒）：rate_limited 冷却取 max(指数退避, 该值)，封顶 cooldownMaxMs */
  retryAfterMs?: number;
}

/** (渠道, 模型) 维度的滑窗指标快照 */
export interface RouteMetrics {
  ok: number;
  fail: number;
  /** 上游 429 次数（窗口内） */
  r429: number;
  /** 时延总和(ms) / 样本数 */
  latSum: number;
  latN: number;
  /** 慢请求样本(>=3s) / 全部样本 */
  slow: number;
  slowTotal: number;
  /** 有效输出 token 总和 / 样本数 */
  outSum: number;
  outN: number;
  /** 有效回复：2xx 且 completionTokens > 0 */
  valid: number;
  /** 无效回复：2xx 但空输出 */
  inval: number;
  /** 拒答/内容过滤类错误（计入质量分母，不伤稳定性、不触发熔断） */
  refuse: number;
  /** 本渠道今日累计调用数 / token 数（自然日，UTC+8，用于每日限额排除） */
  dayReq: number;
  dayTok: number;
  /** 连续失败数（成功即清零，窗口外由 TTL 兜底） */
  cf: number;
  /** 冷却到期时间戳（毫秒） */
  cdexp: number;
  /** 冷却中：cdexp > now → 该候选不进入评分 */
  open: boolean;
  /** 半开：冷却已过但连续失败仍达阈值 → 评分 ×0.1，仅作兜底探测 */
  halfOpen: boolean;
}

/** 滑窗字段（按时间桶分 key 存储，读取时按当前桶覆盖比例线性合并上一桶） */
const WINDOW_FIELDS = [
  'ok',
  'fail',
  'r429',
  'latSum',
  'latN',
  'l1',
  'l2',
  'l3',
  'outSum',
  'outN',
  'valid',
  'inval',
  'refuse',
] as const;

/** 拒答/内容过滤特征（L2 被动信号） */
const REFUSAL_RE = /(content[_\s-]?filter|content_policy|safety|refusal|refused)/i;

function num(v: unknown, d = 0): number {
  const n = typeof v === 'string' ? Number(v) : typeof v === 'number' ? v : Number.NaN;
  return Number.isFinite(n) ? n : d;
}

function hashOf(v: unknown): Record<string, string> | null {
  return v && typeof v === 'object' ? (v as Record<string, string>) : null;
}

function hasData(h: Record<string, string> | null): boolean {
  return !!h && Object.keys(h).length > 0;
}

/**
 * 智能路由指标：按 (渠道, 模型) 在 Redis 记录滑窗指标与熔断状态。
 *
 * - 窗口 key：`route:w:<channel>:<model>:<bucket>`（时间桶，TTL 覆盖当前+上一桶；
 *   读取时把上一桶按剩余时间占比衰减合并，得到近似滑动窗口）
 * - 熔断 key：`route:c:<channel>:<model>`（连续失败 cf / 冷却到期 cdexp / 连续限流 r429）
 * - Redis 不可用时：写入静默跳过并退避重试，读取返回空指标 →
 *   评分退化为「硬分层 + 成本排序」，绝不阻断请求（与 RateLimiterService 同容错策略）
 */
@Injectable()
export class RoutingMetricsService {
  private readonly logger = new Logger(RoutingMetricsService.name);
  readonly windowMs: number;
  readonly snapshotTtlMs: number;
  readonly modelThreshold: number;
  readonly cooldownMs: number;
  readonly cooldownMaxMs: number;
  readonly rateLimitBaseMs: number;
  private readonly winTtlMs: number;
  private readonly circTtlMs = 3_600_000;
  /** 每日限额的自然日分界（默认 UTC+8） */
  private readonly dayOffsetMs: number;
  private readonly retryMs: number;
  /** Redis 故障退避：故障后此时刻前直接降级，不再触碰 Redis */
  private brokenUntil = 0;
  private readonly cache = new Map<string, { at: number; map: Map<string, RouteMetrics> }>();

  constructor(
    private readonly redis: RedisService,
    config: ConfigService,
  ) {
    this.windowMs = Number(config.get<string>('ROUTING_METRICS_WINDOW_MS', '600000')) || 600000;
    this.snapshotTtlMs = Number(config.get<string>('ROUTING_METRICS_TTL_MS', '5000')) || 5000;
    this.retryMs = Number(config.get<string>('ROUTING_METRICS_RETRY_MS', '10000')) || 10000;
    this.modelThreshold = Number(config.get<string>('CHANNEL_MODEL_FAILURE_THRESHOLD', '3')) || 3;
    this.cooldownMs = Number(config.get<string>('CHANNEL_MODEL_COOLDOWN_MS', '60000')) || 60000;
    this.cooldownMaxMs = Math.max(
      Number(config.get<string>('CHANNEL_MODEL_COOLDOWN_MAX_MS', '600000')) || 600000,
      this.cooldownMs,
    );
    this.rateLimitBaseMs =
      Number(config.get<string>('CHANNEL_RATE_LIMIT_BASE_MS', '30000')) || 30000;
    this.dayOffsetMs =
      (Number(config.get<string>('CHANNEL_LIMIT_DAY_OFFSET_HOURS', '8')) || 8) * 3_600_000;
    this.winTtlMs = 2 * this.windowMs + 10_000;
  }

  private winKey(channelId: string, model: string, bucket: number): string {
    return `route:w:${channelId}:${model}:${bucket}`;
  }

  private circKey(channelId: string, model: string): string {
    return `route:c:${channelId}:${model}`;
  }

  /** 每日限额计数 key（按自然日滚动，跨天自动失效） */
  private dayKey(channelId: string, now: number): string {
    return `route:d:${channelId}:${Math.floor((now + this.dayOffsetMs) / 86_400_000)}`;
  }

  /** 日 key TTL = 到当日结束 + 10 分钟宽限 */
  private dayTtl(now: number): number {
    const endOfDay =
      (Math.floor((now + this.dayOffsetMs) / 86_400_000) + 1) * 86_400_000 - this.dayOffsetMs;
    return endOfDay - now + 600_000;
  }

  /**
   * 记录一次上游调用结果（永不抛错；失败时进入退避，避免放大故障）。
   * - ok：成功计数 + 有效/无效回复 + 关闭熔断
   * - rate_limited：429 计数，立即冷却 = max(指数退避, 上游 Retry-After) 并封顶 cooldownMaxMs
   * - error：失败计数，连续失败达阈值 → 冷却 cooldownMs
   */
  async record(
    channelId: string,
    model: string,
    outcome: RouteOutcome,
    args: RouteRecordArgs,
  ): Promise<void> {
    if (Date.now() < this.brokenUntil) return;
    try {
      const now = Date.now();
      const bucket = Math.floor(now / this.windowMs);
      const lat = Math.max(0, Math.round(args.latencyMs || 0));
      const bucketField = lat < 1000 ? 'l1' : lat < 3000 ? 'l2' : 'l3';
      const wKey = this.winKey(channelId, model, bucket);
      const cKey = this.circKey(channelId, model);
      // 每日限额计数：每次上游尝试都计（宁可少用不过量）
      const dKey = this.dayKey(channelId, now);
      const dayTtl = this.dayTtl(now);
      const tokens = Math.max(0, Math.round(args.totalTokens ?? 0));
      const addDaily = (m: ReturnType<RedisService['client']['multi']>) => {
        m.hincrby(dKey, 'req', 1);
        if (tokens > 0) m.hincrby(dKey, 'tok', tokens);
        m.pexpire(dKey, dayTtl);
      };

      if (outcome === 'ok') {
        const out = Math.max(0, Math.round(args.completionTokens ?? 0));
        const status = args.status ?? 200;
        const valid = status >= 200 && status < 300 && out > 0;
        const m = this.redis.client.multi();
        m.pexpire(wKey, this.winTtlMs);
        m.hincrby(wKey, 'latN', 1);
        m.hincrbyfloat(wKey, 'latSum', lat);
        m.hincrby(wKey, bucketField, 1);
        m.hincrby(wKey, 'ok', 1);
        if (valid) {
          m.hincrby(wKey, 'outSum', out);
          m.hincrby(wKey, 'outN', 1);
          m.hincrby(wKey, 'valid', 1);
        } else {
          m.hincrby(wKey, 'inval', 1);
        }
        addDaily(m);
        m.pexpire(cKey, this.circTtlMs);
        m.hset(cKey, 'cf', 0, 'cdexp', 0, 'r429', 0);
        await m.exec();
        return;
      }

      if (outcome === 'refused') {
        // 拒答/内容过滤：只拉低质量分，不计入失败、不触发熔断
        const m = this.redis.client.multi();
        m.pexpire(wKey, this.winTtlMs);
        m.hincrby(wKey, 'latN', 1);
        m.hincrbyfloat(wKey, 'latSum', lat);
        m.hincrby(wKey, bucketField, 1);
        m.hincrby(wKey, 'refuse', 1);
        addDaily(m);
        await m.exec();
        return;
      }

      // 先更新熔断状态，拿到连续计数决定是否冷却（错误路径 2 次 RTT）
      let cdexp = 0;
      if (outcome === 'rate_limited') {
        const c = this.redis.client.multi();
        c.hincrby(cKey, 'r429', 1);
        c.hincrby(cKey, 'cf', 1);
        c.pexpire(cKey, this.circTtlMs);
        const res = await c.exec();
        const n = num(res?.[0]?.[1], 1);
        // 冷却 = max(指数退避, 上游 Retry-After)，再封顶 cooldownMaxMs：
        // 上游明确说等更久就听上游的（避免撞墙），但不能无限放大单渠道出局时长
        const backoff = this.rateLimitBaseMs * 2 ** Math.max(0, n - 1);
        const asked = Math.max(0, Math.round(args.retryAfterMs ?? 0));
        const ttl = Math.min(Math.max(backoff, asked), this.cooldownMaxMs);
        cdexp = now + ttl;
      } else {
        const c = this.redis.client.multi();
        c.hincrby(cKey, 'cf', 1);
        c.pexpire(cKey, this.circTtlMs);
        const res = await c.exec();
        const cf = num(res?.[0]?.[1], 1);
        if (cf >= this.modelThreshold) cdexp = now + this.cooldownMs;
      }

      const m = this.redis.client.multi();
      m.pexpire(wKey, this.winTtlMs);
      m.hincrby(wKey, 'latN', 1);
      m.hincrbyfloat(wKey, 'latSum', lat);
      m.hincrby(wKey, bucketField, 1);
      m.hincrby(wKey, 'fail', 1);
      if (outcome === 'rate_limited') m.hincrby(wKey, 'r429', 1);
      if (REFUSAL_RE.test(String(args.errorMessage ?? ''))) m.hincrby(wKey, 'refuse', 1);
      addDaily(m);
      if (cdexp > 0) m.hset(cKey, 'cdexp', cdexp);
      await m.exec();
    } catch (e) {
      this.brokenUntil = Date.now() + this.retryMs;
      this.logger.warn(`路由指标写入失败（退避 ${this.retryMs}ms）: ${(e as Error)?.message}`);
    }
  }

  /**
   * 读取候选集指标快照（带进程内短 TTL 缓存，避免每请求打 Redis）。
   * Redis 故障 → 返回空 Map，评分自动退化为成本排序。
   */
  async snapshot(model: string, channelIds: string[]): Promise<Map<string, RouteMetrics>> {
    const out = new Map<string, RouteMetrics>();
    if (!channelIds.length) return out;
    const now = Date.now();
    if (now < this.brokenUntil) return out;

    const cacheKey = `${model}|${channelIds.join(',')}`;
    const hit = this.cache.get(cacheKey);
    if (hit && now - hit.at < this.snapshotTtlMs) return hit.map;

    try {
      const bucket = Math.floor(now / this.windowMs);
      // 上一桶按「当前桶已过时间占比」衰减合并 → 近似滑动窗口
      const prevWeight = 1 - (now % this.windowMs) / this.windowMs;
      const m = this.redis.client.multi();
      for (const id of channelIds) {
        m.hgetall(this.winKey(id, model, bucket - 1));
        m.hgetall(this.winKey(id, model, bucket));
        m.hgetall(this.circKey(id, model));
        m.hgetall(this.dayKey(id, now));
      }
      const res = await m.exec();

      channelIds.forEach((id, i) => {
        const prev = hashOf(res?.[i * 4]?.[1]);
        const cur = hashOf(res?.[i * 4 + 1]?.[1]);
        const circ = hashOf(res?.[i * 4 + 2]?.[1]);
        const day = hashOf(res?.[i * 4 + 3]?.[1]);
        if (!hasData(prev) && !hasData(cur) && !hasData(circ) && !hasData(day)) return;

        const w: Record<string, number> = {};
        for (const f of WINDOW_FIELDS) {
          w[f] = num(prev?.[f]) * prevWeight + num(cur?.[f]);
        }
        const cf = num(circ?.cf);
        const cdexp = num(circ?.cdexp);
        const open = cdexp > now;
        out.set(id, {
          ok: w.ok,
          fail: w.fail,
          r429: w.r429,
          latSum: w.latSum,
          latN: w.latN,
          slow: w.l2 + w.l3,
          slowTotal: w.l1 + w.l2 + w.l3,
          outSum: w.outSum,
          outN: w.outN,
          valid: w.valid,
          inval: w.inval,
          refuse: w.refuse,
          dayReq: num(day?.req),
          dayTok: num(day?.tok),
          cf,
          cdexp,
          open,
          halfOpen: !open && cf >= this.modelThreshold,
        });
      });
    } catch (e) {
      this.brokenUntil = Date.now() + this.retryMs;
      this.logger.warn(
        `路由指标读取失败（退避 ${this.retryMs}ms，降级为成本排序）: ${(e as Error)?.message}`,
      );
      return new Map();
    }

    if (this.cache.size > 300) this.cache.clear();
    this.cache.set(cacheKey, { at: now, map: out });
    return out;
  }
}
