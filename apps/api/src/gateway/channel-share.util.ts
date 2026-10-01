import { ChannelShareMode, ChannelShareUrgency } from '@prisma/client';

/** `shareExhausted()` 需要的最小字段集（避免调用方为过滤而查整行） */
export interface ShareGateChannel {
  shareMode?: ChannelShareMode | null;
  shareUntil?: Date | null;
  shareQuotaCostUsd?: unknown;
  shareQuotaRequests?: number | null;
  shareUsedCostUsd?: unknown;
  shareUsedRequests?: number | null;
}

/**
 * 共享渠道是否已「用尽」：达到额度上限（折算上游成本 / 调用次数）或已过期。
 *
 * PRIVATE 渠道恒为 false——这套闸门只约束共享渠道。
 * 命中即不再派发，等价于「自动停止接单」，服务于渠道主
 * 「把本月快到期、用不完的额度烧掉一部分就收手」的诉求。
 *
 * 累计值由网关闭环累加在 Channel 列上（见 UsageService.record），
 * 因此路由侧只需读已取出的行，零额外查询。
 */
export function shareExhausted(channel?: ShareGateChannel | null, now = Date.now()): boolean {
  if (!channel) return false;
  if (!channel.shareMode || channel.shareMode === ChannelShareMode.PRIVATE) return false;
  if (channel.shareUntil && channel.shareUntil.getTime() <= now) return true;

  const quotaCost =
    channel.shareQuotaCostUsd != null ? Number(channel.shareQuotaCostUsd) : null;
  if (
    quotaCost != null &&
    quotaCost > 0 &&
    Number(channel.shareUsedCostUsd ?? 0) >= quotaCost
  ) {
    return true;
  }
  const quotaReq = channel.shareQuotaRequests ?? null;
  if (quotaReq != null && quotaReq > 0 && (channel.shareUsedRequests ?? 0) >= quotaReq) {
    return true;
  }
  return false;
}

/**
 * 共享紧急度 → 优先级加成：额度/时间快用不完的渠道主希望被优先派发（清仓）。
 * 只在质量分 ≥0.85 时生效，避免把明显更差的上游排到前面；加成上限 6（不跨越人工 priority 的常规粒度）。
 */
export const SHARE_URGENCY_BONUS: Record<ChannelShareUrgency, number> = {
  NORMAL: 0,
  HIGH: 3,
  FLUSH: 6,
};

export function shareUrgencyBonus(
  channel: {
    ownerType?: string | null;
    shareMode?: ChannelShareMode | null;
    shareUrgency?: ChannelShareUrgency | null;
  },
  qualityScore: unknown,
): number {
  if (channel.ownerType !== 'USER') return 0;
  if (!channel.shareMode || channel.shareMode === ChannelShareMode.PRIVATE) return 0;
  if (!channel.shareUrgency || channel.shareUrgency === ChannelShareUrgency.NORMAL) return 0;
  const q = Number(qualityScore ?? 1) || 1;
  if (q < 0.85) return 0;
  return SHARE_URGENCY_BONUS[channel.shareUrgency] ?? 0;
}
