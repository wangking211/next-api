import { ChannelShareMode, ChannelShareUrgency, Prisma } from '@prisma/client';
import {
  SHARE_URGENCY_BONUS,
  ShareGateChannel,
  shareExhausted,
  shareUrgencyBonus,
} from './channel-share.util';

/** 固定「当前时刻」，所有时间断言显式传 now，避免用例随真实时钟漂移 */
const NOW = 1_700_000_000_000;
const PAST = new Date(NOW - 60_000);
const FUTURE = new Date(NOW + 60_000);

function shared(partial: Partial<ShareGateChannel> = {}): ShareGateChannel {
  return { shareMode: ChannelShareMode.PUBLIC, ...partial };
}

describe('shareExhausted（共享渠道额度/有效期闸门）', () => {
  it('undefined / null channel → false', () => {
    expect(shareExhausted(undefined, NOW)).toBe(false);
    expect(shareExhausted(null, NOW)).toBe(false);
  });

  it('shareMode 缺失（undefined / null）→ false', () => {
    expect(shareExhausted({ shareMode: undefined }, NOW)).toBe(false);
    expect(shareExhausted({ shareMode: null }, NOW)).toBe(false);
  });

  it('PRIVATE 渠道恒为 false，即使额度已超 / 已过期', () => {
    expect(
      shareExhausted(
        {
          shareMode: ChannelShareMode.PRIVATE,
          shareQuotaCostUsd: 1,
          shareUsedCostUsd: 999,
          shareQuotaRequests: 1,
          shareUsedRequests: 999,
          shareUntil: PAST,
        },
        NOW,
      ),
    ).toBe(false);
  });

  it('shareUntil 已到点（<= now）→ true（非 PRIVATE）', () => {
    expect(shareExhausted(shared({ shareUntil: PAST }), NOW)).toBe(true);
    // 恰好等于 now 也算过期（<= 边界）
    expect(shareExhausted(shared({ shareUntil: new Date(NOW) }), NOW)).toBe(true);
  });

  it('shareUntil 在未来 → false', () => {
    expect(shareExhausted(shared({ shareUntil: FUTURE }), NOW)).toBe(false);
  });

  describe('成本额度（shareQuotaCostUsd）', () => {
    it('used < quota → false；used == quota → true；used > quota → true', () => {
      expect(
        shareExhausted(shared({ shareQuotaCostUsd: 10, shareUsedCostUsd: 9.99 }), NOW),
      ).toBe(false);
      expect(
        shareExhausted(shared({ shareQuotaCostUsd: 10, shareUsedCostUsd: 10 }), NOW),
      ).toBe(true);
      expect(
        shareExhausted(shared({ shareQuotaCostUsd: 10, shareUsedCostUsd: 15 }), NOW),
      ).toBe(true);
    });

    it('quota 为 null / undefined / 0 → 跳过成本检查（used 再大也不算用尽）', () => {
      expect(
        shareExhausted(shared({ shareQuotaCostUsd: null, shareUsedCostUsd: 1e9 }), NOW),
      ).toBe(false);
      expect(
        shareExhausted(shared({ shareQuotaCostUsd: undefined, shareUsedCostUsd: 1e9 }), NOW),
      ).toBe(false);
      expect(
        shareExhausted(shared({ shareQuotaCostUsd: 0, shareUsedCostUsd: 1e9 }), NOW),
      ).toBe(false);
    });

    it('used 为 null / undefined → 视作 0', () => {
      expect(
        shareExhausted(shared({ shareQuotaCostUsd: 10, shareUsedCostUsd: null }), NOW),
      ).toBe(false);
      expect(
        shareExhausted(shared({ shareQuotaCostUsd: 10, shareUsedCostUsd: undefined }), NOW),
      ).toBe(false);
    });

    it('quota 走 Number() 强制转换：plain number / 字符串 / Prisma Decimal 均可比', () => {
      expect(
        shareExhausted(shared({ shareQuotaCostUsd: 10, shareUsedCostUsd: 10.5 }), NOW),
      ).toBe(true);
      expect(
        shareExhausted(shared({ shareQuotaCostUsd: '10', shareUsedCostUsd: 10 }), NOW),
      ).toBe(true);
      expect(
        shareExhausted(
          shared({ shareQuotaCostUsd: new Prisma.Decimal('10.5'), shareUsedCostUsd: 10.5 }),
          NOW,
        ),
      ).toBe(true);
      expect(
        shareExhausted(
          shared({ shareQuotaCostUsd: new Prisma.Decimal('10.5'), shareUsedCostUsd: 10.4 }),
          NOW,
        ),
      ).toBe(false);
    });
  });

  describe('请求次数额度（shareQuotaRequests）', () => {
    it('used < quota → false；used == quota → true；used > quota → true', () => {
      expect(
        shareExhausted(shared({ shareQuotaRequests: 100, shareUsedRequests: 99 }), NOW),
      ).toBe(false);
      expect(
        shareExhausted(shared({ shareQuotaRequests: 100, shareUsedRequests: 100 }), NOW),
      ).toBe(true);
      expect(
        shareExhausted(shared({ shareQuotaRequests: 100, shareUsedRequests: 101 }), NOW),
      ).toBe(true);
    });

    it('quota 为 0 / null / undefined → 跳过请求检查', () => {
      expect(
        shareExhausted(shared({ shareQuotaRequests: 0, shareUsedRequests: 1e9 }), NOW),
      ).toBe(false);
      expect(
        shareExhausted(shared({ shareQuotaRequests: null, shareUsedRequests: 1e9 }), NOW),
      ).toBe(false);
      expect(
        shareExhausted(shared({ shareQuotaRequests: undefined, shareUsedRequests: 1e9 }), NOW),
      ).toBe(false);
    });

    it('used 为 null / undefined → 视作 0', () => {
      expect(
        shareExhausted(shared({ shareQuotaRequests: 100, shareUsedRequests: null }), NOW),
      ).toBe(false);
      expect(
        shareExhausted(shared({ shareQuotaRequests: 100, shareUsedRequests: undefined }), NOW),
      ).toBe(false);
    });
  });
});

describe('shareUrgencyBonus（共享紧急度 → 路由优先级加成）', () => {
  const userShared = {
    ownerType: 'USER',
    shareMode: ChannelShareMode.PUBLIC,
    shareUrgency: ChannelShareUrgency.HIGH,
  };

  it('ownerType 非 USER → 0（即使 HIGH）', () => {
    expect(shareUrgencyBonus({ ...userShared, ownerType: 'PLATFORM' }, 1)).toBe(0);
    expect(shareUrgencyBonus({ ...userShared, ownerType: null }, 1)).toBe(0);
    expect(shareUrgencyBonus({ ...userShared, ownerType: undefined }, 1)).toBe(0);
  });

  it('shareMode 为 PRIVATE / null / undefined → 0', () => {
    expect(shareUrgencyBonus({ ...userShared, shareMode: ChannelShareMode.PRIVATE }, 1)).toBe(0);
    expect(shareUrgencyBonus({ ...userShared, shareMode: null }, 1)).toBe(0);
    expect(shareUrgencyBonus({ ...userShared, shareMode: undefined }, 1)).toBe(0);
  });

  it('shareUrgency 为 NORMAL / null / undefined → 0', () => {
    expect(shareUrgencyBonus({ ...userShared, shareUrgency: ChannelShareUrgency.NORMAL }, 1)).toBe(0);
    expect(shareUrgencyBonus({ ...userShared, shareUrgency: null }, 1)).toBe(0);
    expect(shareUrgencyBonus({ ...userShared, shareUrgency: undefined }, 1)).toBe(0);
  });

  it('qualityScore < 0.85 → 0（即使 FLUSH）', () => {
    expect(
      shareUrgencyBonus(
        { ...userShared, shareUrgency: ChannelShareUrgency.FLUSH },
        0.84,
      ),
    ).toBe(0);
    expect(
      shareUrgencyBonus(
        { ...userShared, shareUrgency: ChannelShareUrgency.FLUSH },
        0.849999,
      ),
    ).toBe(0);
  });

  it('qualityScore 缺失/0/垃圾值经 Number() 兜底后视作 1 → 照常加成', () => {
    const flush = { ...userShared, shareUrgency: ChannelShareUrgency.FLUSH };
    // null ?? 1 = 1
    expect(shareUrgencyBonus(flush, null)).toBe(6);
    // undefined ?? 1 = 1
    expect(shareUrgencyBonus(flush, undefined)).toBe(6);
    // Number(0) || 1 = 1（0 被兜底，而非判为低分）
    expect(shareUrgencyBonus(flush, 0)).toBe(6);
    // Number('abc') = NaN，NaN || 1 = 1
    expect(shareUrgencyBonus(flush, 'abc')).toBe(6);
  });

  it('qualityScore 恰好 0.85 → 照常加成（>= 边界）', () => {
    expect(
      shareUrgencyBonus(
        { ...userShared, shareUrgency: ChannelShareUrgency.FLUSH },
        0.85,
      ),
    ).toBe(6);
  });

  it('HIGH → 3、FLUSH → 6，与 SHARE_URGENCY_BONUS 导出一致', () => {
    expect(shareUrgencyBonus({ ...userShared, shareUrgency: ChannelShareUrgency.HIGH }, 1)).toBe(3);
    expect(shareUrgencyBonus({ ...userShared, shareUrgency: ChannelShareUrgency.FLUSH }, 1)).toBe(6);
    expect(SHARE_URGENCY_BONUS.HIGH).toBe(3);
    expect(SHARE_URGENCY_BONUS.FLUSH).toBe(6);
    expect(SHARE_URGENCY_BONUS.NORMAL).toBe(0);
  });
});
