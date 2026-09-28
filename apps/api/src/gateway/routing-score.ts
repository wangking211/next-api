import { RoutingStrategy } from '@prisma/client';
import type { RouteMetrics } from './routing-metrics.service';

/**
 * 智能路由评分（纯函数，无 IO）。
 *
 * 硬分层不参与评分：tier（BYOK 优先）→ priority（人工指定）由排序层保证；
 * 评分只决定同一 (tier, priority) 层内候选的先后。
 * 各维度先归一化到 [0,1] 再按策略权重加权；无数据维度回退 0.5（中性），
 * 因此「无任何指标」时排序退化为 价格升序 + 分流噪声，与旧的 cost asc 兼容。
 */

export interface ScoreWeights {
  /** 价格：越便宜得分越高 */
  price: number;
  /** 速度/性能：时延、慢请求占比、吞吐 */
  speed: number;
  /** 稳定性：滑窗成功率 */
  stability: number;
  /** 质量：L1 人工分 + L2 被动信号 */
  quality: number;
  /** 分流噪声：让 weight 真正生效（灰度/按比例分流） */
  noise: number;
}

/** 五维权重预设（Σ=1） */
export const STRATEGY_WEIGHTS: Record<RoutingStrategy, ScoreWeights> = {
  BALANCED: { price: 0.3, speed: 0.2, stability: 0.25, quality: 0.2, noise: 0.05 },
  CHEAPEST: { price: 0.65, speed: 0.05, stability: 0.15, quality: 0.1, noise: 0.05 },
  FASTEST: { price: 0.1, speed: 0.55, stability: 0.25, quality: 0.05, noise: 0.05 },
  STABLE: { price: 0.1, speed: 0.15, stability: 0.6, quality: 0.1, noise: 0.05 },
  QUALITY_FIRST: { price: 0.1, speed: 0.1, stability: 0.2, quality: 0.55, noise: 0.05 },
};

export const DEFAULT_STRATEGY: RoutingStrategy = 'BALANCED';

export function isRoutingStrategy(v: unknown): v is RoutingStrategy {
  return typeof v === 'string' && Object.prototype.hasOwnProperty.call(STRATEGY_WEIGHTS, v);
}

export interface ScoreInput {
  id: string;
  /** 路由成本 USD/1M（输入侧）；<=0 或非有限值视为未知 */
  cost: number;
  /** 分流权重（weight 越大越可能被优先） */
  weight: number;
  /** L1 人工质量分 0~2（1=正常） */
  qualityScore: number;
  /** Redis 滑窗指标；undefined = 无数据 */
  metrics?: RouteMetrics;
  /** 熔断半开 / 冷却兜底使用时 → 总分 ×0.1 */
  penalized?: boolean;
}

export interface ScoreTerms {
  price: number;
  speed: number;
  stability: number;
  quality: number;
  noise: number;
}

export interface Scored {
  score: number;
  terms: ScoreTerms;
}

const NEUTRAL = 0.5;

/**
 * min-max 归一化到 [0,1]。
 * - 无数据（null/undefined/非有限）按 unknown 策略处理：'worst' 排末位、'neutral' 记中性分
 * - 全部有数据且彼此相等 → 统一中性分（不产生歧视）
 */
function normalize(
  values: (number | null | undefined)[],
  opts: { higherBetter: boolean; unknown?: 'worst' | 'neutral' },
): number[] {
  const finite = values.filter(
    (v): v is number => typeof v === 'number' && Number.isFinite(v),
  );
  if (!finite.length) return values.map(() => NEUTRAL);
  const min = Math.min(...finite);
  const max = Math.max(...finite);
  const unknownScore = opts.unknown === 'worst' ? 0 : NEUTRAL;
  const isFinite = (v: number | null | undefined): v is number =>
    typeof v === 'number' && Number.isFinite(v);
  if (min === max) return values.map((v) => (isFinite(v) ? NEUTRAL : unknownScore));
  return values.map((v) => {
    if (!isFinite(v)) return unknownScore;
    const t = (v - min) / (max - min);
    return opts.higherBetter ? t : 1 - t;
  });
}

/** 计算候选集评分，返回 id → 评分（含各维度分项，便于调试输出） */
export function scoreCandidates(
  inputs: ScoreInput[],
  strategy: RoutingStrategy | null | undefined,
): Map<string, Scored> {
  const out = new Map<string, Scored>();
  if (!inputs.length) return out;
  const weights =
    (strategy && STRATEGY_WEIGHTS[strategy]) || STRATEGY_WEIGHTS[DEFAULT_STRATEGY];

  // 1) 价格（越便宜越好；未知成本 → 最差）
  const prices = normalize(
    inputs.map((i) => (Number.isFinite(i.cost) && i.cost > 0 ? i.cost : null)),
    { higherBetter: false, unknown: 'worst' },
  );

  // 2) 速度/性能：平均时延 0.6 + 慢请求占比 0.2 + 吞吐(tokens/s) 0.2
  const avgLat: (number | null)[] = [];
  const slowRatio: (number | null)[] = [];
  const tps: (number | null)[] = [];
  for (const i of inputs) {
    const m = i.metrics;
    const latN = m?.latN ?? 0;
    avgLat.push(latN > 0 && m ? m.latSum / latN : null);
    const total = m?.slowTotal ?? 0;
    slowRatio.push(total > 0 && m ? m.slow / total : null);
    tps.push(m && m.latSum > 0 ? (m.outSum / m.latSum) * 1000 : null);
  }
  const latScore = normalize(avgLat, { higherBetter: false });
  const slowScore = normalize(slowRatio, { higherBetter: false });
  const tpsScore = normalize(tps, { higherBetter: true });
  const speeds = inputs.map(
    (_, k) => 0.6 * latScore[k] + 0.2 * slowScore[k] + 0.2 * tpsScore[k],
  );

  // 3) 稳定性：滑窗成功率拉普拉斯平滑（无数据恰好 = 0.5）
  const stabilities = inputs.map((i) => {
    const ok = i.metrics?.ok ?? 0;
    const fail = i.metrics?.fail ?? 0;
    return (ok + 1) / (ok + fail + 2);
  });

  // 4) 质量 = L1 人工分 × 0.5 + L2 被动信号 × 0.5
  //    L2 = 有效回复率 0.6 + 平均输出长度偏离 0.4（空回复/拒答拉低有效率）
  const qualityScores = normalize(inputs.map((i) => i.qualityScore), {
    higherBetter: true,
  });
  const avgOut = normalize(
    inputs.map((i) =>
      i.metrics && i.metrics.outN > 0 ? i.metrics.outSum / i.metrics.outN : null,
    ),
    { higherBetter: true },
  );
  const quals = inputs.map((i, k) => {
    const m = i.metrics;
    const valid = m?.valid ?? 0;
    const inval = m?.inval ?? 0;
    const refuse = m?.refuse ?? 0;
    const validRate = (valid + 1) / (valid + inval + refuse + 2);
    const l2 = 0.6 * validRate + 0.4 * avgOut[k];
    return 0.5 * qualityScores[k] + 0.5 * l2;
  });

  // 5) 分流噪声：指数竞速 gumbel = -ln(U)/weight（越小越好），weight 越大越占优
  const gumbels = inputs.map(
    (i) => -Math.log(Math.random() || 1e-9) / Math.max(i.weight, 1),
  );
  const noises = normalize(gumbels, { higherBetter: false });

  for (let k = 0; k < inputs.length; k++) {
    const terms: ScoreTerms = {
      price: prices[k],
      speed: speeds[k],
      stability: stabilities[k],
      quality: quals[k],
      noise: noises[k],
    };
    let score =
      weights.price * terms.price +
      weights.speed * terms.speed +
      weights.stability * terms.stability +
      weights.quality * terms.quality +
      weights.noise * terms.noise;
    if (inputs[k].penalized) score *= 0.1;
    out.set(inputs[k].id, { score, terms });
  }
  return out;
}

/** FNV-1a 32 位哈希，用于把粘性键稳定映射到候选序号 */
export function fnv1a(str: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}

/**
 * 会话粘性（保 prompt cache）：只在与榜首同 (tier, priority) 的组内旋转，
 * 且偏好候选得分 ≥ ratio × 榜首得分才前置——不为保缓存死抱劣质渠道。
 * 返回被前置的候选（未生效返回 null）。
 */
export function applySticky<T extends { id: string; tier: number; priority: number }>(
  ranked: T[],
  scores: Map<string, Scored>,
  stickyKey: string,
  ratio: number,
): T | null {
  if (ranked.length < 2) return null;
  const top = ranked[0];
  let end = 1;
  while (
    end < ranked.length &&
    ranked[end].tier === top.tier &&
    ranked[end].priority === top.priority
  ) {
    end++;
  }
  if (end < 2) return null; // 同层仅一个候选，无处可粘
  const idx = fnv1a(stickyKey) % end;
  if (idx === 0) return null;
  const pref = ranked[idx];
  const topScore = scores.get(top.id)?.score ?? 0;
  const prefScore = scores.get(pref.id)?.score ?? 0;
  if (prefScore < ratio * topScore) return null;
  for (let i = idx; i > 0; i--) ranked[i] = ranked[i - 1];
  ranked[0] = pref;
  return pref;
}
