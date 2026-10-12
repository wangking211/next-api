/**
 * 精确匹配响应缓存（response cache）：同一「候选渠道集合 + 模型 + 请求体」在 TTL 内
 * 复用已生成的响应，按折扣计费、零上游成本。
 *
 * 口径与边界（与语义缓存的本质区别：零误判，不穿分组）：
 * - 缓存键包含排序后的候选渠道 ID 集合：分组/BYOK/共享可见性天然隔离，
 *   国内合规组与海外组的候选集不同 → 键不同，绝无跨组串答案；
 * - 只做精确匹配（sha256 规范化请求体），不做语义相似，不污染 L2 路由信号；
 * - 服务端策略 shouldHandle：显式 cache:true 才对「高温采样」请求生效，
 *   temperature===0（确定性请求）自动生效；cache:false 强制绕过；
 * - Redis 故障 fail-open（含 30s 冷却，避免热路径反复等重连），
 *   响应体积超限（RESPONSE_CACHE_MAX_BYTES）不缓存；
 * - 拒答（content_filter / refusal）不缓存：缓存会让后续命中跳过换渠道重试。
 */
import { Injectable, Logger, Optional } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { createHash } from 'crypto';
import { RedisService } from '../redis/redis.service';
import type { UsageInfo } from './types';

/** Redis 中的缓存记录（v 用于将来不兼容变更时的整体失效） */
export interface CachedChatRecord {
  v: 1;
  /** 生成该响应的渠道 id：命中落账时在当前候选里取回渠道行（计费/分成同口径） */
  channelId: string;
  /** 生成时的真实用量：命中落账直接复用，避免流式重放时估算偏差 */
  usage: UsageInfo;
  /** 非流式：完整 OpenAI 响应对象 */
  json?: Record<string, any>;
  /** 流式：原始 OpenAI SSE 文本块（按序重放，anthropic 客户端再经翻译器转换） */
  chunks?: string[];
}

/** Redis 故障后的冷却窗口：期间跳过缓存读写，避免热路径反复等待重连 */
const FAILURE_COOLDOWN_MS = 30_000;

/**
 * 非流式拒答判定：finish_reason=content_filter 或存在 refusal 文本。
 * 拒答不缓存 —— 缓存命中会跳过「换下一家再试」（不同供应商审核宽严不同）。
 */
export function refusalInJson(json: any): boolean {
  return (json?.choices ?? []).some(
    (c: any) => c?.finish_reason === 'content_filter' || !!c?.message?.refusal,
  );
}

/**
 * 流式拒答判定（保守子串匹配）：扫描原始分片里的 content_filter / "refusal"。
 * 误报只损失一次写回（少缓存），不影响正确性；漏报才可能缓存到拒答，故宁可过严。
 */
export function refusalInStreamChunks(chunks: string[]): boolean {
  return chunks.some((c) => c.includes('content_filter') || c.includes('"refusal"'));
}

/** 规范化 JSON：对象键排序、数组保序 → 键与字段顺序无关，哈希稳定 */
export function canonicalize(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (value && typeof value === 'object') {
    const src = value as Record<string, unknown>;
    const out: Record<string, unknown> = {};
    for (const k of Object.keys(src).sort()) out[k] = canonicalize(src[k]);
    return out;
  }
  return value;
}

/** 记录结构校验：Redis 值可能被外部改写/写坏，非法一律按 miss 处理 */
function isValidRecord(rec: unknown): rec is CachedChatRecord {
  if (!rec || typeof rec !== 'object') return false;
  const r = rec as Partial<CachedChatRecord>;
  const u = r.usage as Partial<UsageInfo> | undefined;
  return (
    r.v === 1 &&
    typeof r.channelId === 'string' &&
    !!u &&
    Number.isFinite(u.promptTokens) &&
    Number.isFinite(u.completionTokens) &&
    Number.isFinite(u.totalTokens) &&
    (r.json != null || (Array.isArray(r.chunks) && r.chunks.length > 0))
  );
}

@Injectable()
export class ResponseCacheService {
  private readonly logger = new Logger(ResponseCacheService.name);
  /** 全局开关（RESPONSE_CACHE_ENABLED，默认开；kill switch 用） */
  readonly enabled: boolean;
  /** 命中折扣（0<折扣<1；用户实付 = 原价 × 折扣，平台无上游成本） */
  readonly discount: number;
  /** 条目 TTL（毫秒） */
  readonly ttlMs: number;
  /** 单条记录体积上限（字节）：超限不缓存（长输出/多模态大响应直接跳过） */
  readonly maxBytes: number;
  /** Redis 故障冷却截止时刻（fail-open：冷却期内跳过读写） */
  private downUntil = 0;

  constructor(
    config: ConfigService,
    @Optional() private readonly redis?: RedisService,
  ) {
    this.enabled = config.get<string>('RESPONSE_CACHE_ENABLED', 'true') !== 'false';
    const discount = Number(config.get<string>('RESPONSE_CACHE_DISCOUNT', '0.6'));
    this.discount = Number.isFinite(discount) && discount > 0 && discount < 1 ? discount : 0.6;
    const ttl = Number(config.get<string>('RESPONSE_CACHE_TTL_MS', '600000'));
    this.ttlMs = Number.isFinite(ttl) && ttl >= 1000 ? Math.min(ttl, 3_600_000) : 600_000;
    const maxBytes = Number(config.get<string>('RESPONSE_CACHE_MAX_BYTES', '524288'));
    this.maxBytes =
      Number.isFinite(maxBytes) && maxBytes >= 1024 ? Math.min(maxBytes, 8_388_608) : 524_288;
  }

  /**
   * 本次请求是否走缓存（读与写同一口径）：
   * - cache:false → 强制绕过（用户显式要全新生成）
   * - cache:true → 任意采样参数都命中（调用方自行承担「相同请求得到相同答案」）
   * - 否则仅 temperature===0（确定性请求）自动命中：语义上等价，无意外
   */
  shouldHandle(body: Record<string, any>): boolean {
    if (!this.enabled || !this.redis) return false;
    if (body?.cache === false) return false;
    if (body?.cache === true) return true;
    return body?.temperature === 0;
  }

  /**
   * 缓存键 = sha256(模型(规范名) × 是否流式 × 候选渠道ID集合(排序) × 规范化请求体)。
   * 候选集进键是合规隔离的关键：可见渠道不同（分组/BYOK/共享）则键不同。
   * 请求体里 model 归一到规范名（别名命中同一份缓存）、stream 抽出单独参与哈希。
   */
  key(model: string, body: Record<string, any>, isStream: boolean, channelIds: string[]): string {
    const normalized: Record<string, any> = { ...body, model, stream: undefined };
    delete normalized.stream;
    const material = JSON.stringify({
      m: model,
      s: isStream,
      ch: [...channelIds].sort(),
      b: canonicalize(normalized),
    });
    return `gw:rc:v1:${createHash('sha256').update(material).digest('hex')}`;
  }

  /** 读缓存；Redis 故障/记录非法一律 null（fail-open） */
  async get(k: string): Promise<CachedChatRecord | null> {
    if (!this.enabled || !this.redis || Date.now() < this.downUntil) return null;
    try {
      const raw = await this.redis.client.get(k);
      if (!raw) return null;
      const parsed: unknown = JSON.parse(raw);
      return isValidRecord(parsed) ? parsed : null;
    } catch (e) {
      this.markDown(e);
      return null;
    }
  }

  /** 写缓存（体积超限或 Redis 故障时静默跳过） */
  async set(k: string, record: CachedChatRecord): Promise<void> {
    if (!this.enabled || !this.redis || Date.now() < this.downUntil) return;
    let payload: string;
    try {
      payload = JSON.stringify(record);
    } catch {
      return; // 不可序列化（理论不可能：记录由本进程构造）
    }
    if (Buffer.byteLength(payload, 'utf8') > this.maxBytes) {
      this.logger.debug(`响应缓存跳过写入：记录超过 ${this.maxBytes} 字节`);
      return;
    }
    try {
      await this.redis.client.setex(k, Math.ceil(this.ttlMs / 1000), payload);
    } catch (e) {
      this.markDown(e);
    }
  }

  private markDown(e: unknown): void {
    this.downUntil = Date.now() + FAILURE_COOLDOWN_MS;
    this.logger.warn(
      `响应缓存 Redis 故障（fail-open，冷却 ${FAILURE_COOLDOWN_MS / 1000}s）: ${(e as Error)?.message}`,
    );
  }
}
