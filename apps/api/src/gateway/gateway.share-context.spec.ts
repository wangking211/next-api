import { ConfigService } from '@nestjs/config';
import { ChannelOwnerType, ChannelShareMode } from '@prisma/client';
import type { Channel } from '@prisma/client';
import { ExecSupportService } from './exec-support.service';
import { ChannelResolverService } from './channel-resolver.service';
import { UsageService } from '../usage/usage.service';
import { BillingService } from '../billing/billing.service';
import { PrismaService } from '../prisma/prisma.service';
import { ChannelHealthService } from './channel-health.service';
import { RoutingMetricsService } from './routing-metrics.service';

/**
 * shareContext + isSharedFromOthers + BillingService.channelShareFeeBps 行为特征化：
 * 该链路决定「他人调用我的共享渠道」时渠道主按什么比例分成——口径必须钉死。
 *
 * P2-1 拆分后本 spec 随 shareContext 从 GatewayController 迁至 ExecSupportService，
 * 断言语义零改动（方法体为原样搬移）。
 *
 * 断言全部基于现有生产代码逐条读出的语义：
 * - isSharedFromOthers：ownerType=USER && shareMode≠PRIVATE && ownerUserId 存在 && ≠ 调用者
 *   （不查 groups——可见性判定只看 shareMode，GROUP/PUBLIC 一律视为已共享）
 * - shareContext：非共享 → undefined；共享 → { ownerUserId, feeBps: billing.channelShareFeeBps(channel) }
 * - channelShareFeeBps：渠道覆盖 ?? 全局 CHANNEL_SHARE_FEE_BPS（默认 2000），再钳到 [0,10000] 并向下取整
 */

/** 走真实 BillingService（channelShareFeeBps 是纯函数，不触库），env 模拟 ConfigService 键值 */
function makeBilling(env?: Record<string, string>) {
  const config = { get: (key: string, def?: string) => env?.[key] ?? def };
  return new BillingService(
    {} as unknown as PrismaService,
    undefined,
    config as unknown as ConfigService,
  );
}

function makeSupport(billing: BillingService) {
  return new ExecSupportService(
    {} as unknown as ChannelResolverService,
    {} as unknown as UsageService,
    billing,
    {} as unknown as ChannelHealthService,
    {} as unknown as RoutingMetricsService,
    { get: (_k: string, d?: string) => d } as unknown as ConfigService,
  );
}

/** 默认形态：他人公开共享的 USER 渠道（各用例按需覆盖字段） */
function makeChannel(overrides: Partial<Channel> = {}): Channel {
  return {
    id: 'ch-share',
    ownerType: ChannelOwnerType.USER,
    ownerUserId: 'owner-1',
    shareMode: ChannelShareMode.PUBLIC,
    shareFeeBps: null,
    ...overrides,
  } as unknown as Channel;
}

function share(support: ExecSupportService, channel: Channel, callerUserId: string) {
  return support.shareContext(channel, callerUserId);
}

describe('ExecSupportService.shareContext（共享分成上下文，行为特征化）', () => {
  describe('isSharedFromOthers 判定', () => {
    it('调用者即渠道主 → undefined（自有渠道走 BYOK，不分成）', () => {
      const support = makeSupport(makeBilling());
      expect(share(support, makeChannel(), 'owner-1')).toBeUndefined();
    });

    it('平台渠道（ownerType=PLATFORM）→ undefined（平台渠道无分成对象）', () => {
      const support = makeSupport(makeBilling());
      const channel = makeChannel({ ownerType: ChannelOwnerType.PLATFORM });
      expect(share(support, channel, 'caller-1')).toBeUndefined();
    });

    it('他人 PUBLIC 共享渠道 → { ownerUserId, feeBps }', () => {
      const support = makeSupport(makeBilling());
      expect(share(support, makeChannel(), 'caller-1')).toEqual({
        ownerUserId: 'owner-1',
        feeBps: 2000,
      });
    });

    it('shareMode=GROUP 同样视为共享（判定只排除 PRIVATE）', () => {
      const support = makeSupport(makeBilling());
      const channel = makeChannel({ shareMode: ChannelShareMode.GROUP });
      expect(share(support, channel, 'caller-1')).toEqual({
        ownerUserId: 'owner-1',
        feeBps: 2000,
      });
    });

    it('shareMode=PRIVATE → undefined（未开放共享，即便 owner 是他人）', () => {
      const support = makeSupport(makeBilling());
      const channel = makeChannel({ shareMode: ChannelShareMode.PRIVATE });
      expect(share(support, channel, 'caller-1')).toBeUndefined();
    });

    it('ownerUserId 缺失 → undefined（USER 渠道孤儿行防御）', () => {
      const support = makeSupport(makeBilling());
      const channel = makeChannel({ ownerUserId: null });
      expect(share(support, channel, 'caller-1')).toBeUndefined();
    });

    it('共享场景返回的 ownerUserId 即渠道主', () => {
      const support = makeSupport(makeBilling());
      const channel = makeChannel({ ownerUserId: 'owner-42' });
      expect(share(support, channel, 'caller-1')).toEqual(
        expect.objectContaining({ ownerUserId: 'owner-42' }),
      );
    });
  });

  describe('feeBps 协作（真实 BillingService.channelShareFeeBps）', () => {
    it('feeBps 取自 billing.channelShareFeeBps(channel)，非硬编码', () => {
      const billing = makeBilling();
      const spy = jest.spyOn(billing, 'channelShareFeeBps');
      const support = makeSupport(billing);
      const channel = makeChannel({ shareFeeBps: 500 });
      expect(share(support, channel, 'caller-1')).toEqual({
        ownerUserId: 'owner-1',
        feeBps: 500,
      });
      expect(spy).toHaveBeenCalledWith(channel);
    });

    it('每渠道覆盖优先于全局默认（env=1500、渠道=500 → 500）', () => {
      const support = makeSupport(makeBilling({ CHANNEL_SHARE_FEE_BPS: '1500' }));
      expect(share(support, makeChannel({ shareFeeBps: 500 }), 'caller-1')).toEqual(
        expect.objectContaining({ feeBps: 500 }),
      );
    });

    it('每渠道覆盖 shareFeeBps=0 被保留（nullish 合并不把 0 当缺省）', () => {
      const support = makeSupport(makeBilling({ CHANNEL_SHARE_FEE_BPS: '1500' }));
      expect(share(support, makeChannel({ shareFeeBps: 0 }), 'caller-1')).toEqual(
        expect.objectContaining({ feeBps: 0 }),
      );
    });

    it('覆盖超上界钳制：99999 → 10000（满抽 100%）', () => {
      const support = makeSupport(makeBilling());
      const channel = makeChannel({ shareFeeBps: 99999 });
      expect(share(support, channel, 'caller-1')).toEqual(
        expect.objectContaining({ feeBps: 10000 }),
      );
    });

    it('覆盖为负钳制：-5 → 0', () => {
      const support = makeSupport(makeBilling());
      const channel = makeChannel({ shareFeeBps: -5 });
      expect(share(support, channel, 'caller-1')).toEqual(expect.objectContaining({ feeBps: 0 }));
    });

    it('非整数覆盖向下取整：1500.9 → 1500', () => {
      const support = makeSupport(makeBilling());
      const channel = makeChannel({ shareFeeBps: 1500.9 });
      expect(share(support, channel, 'caller-1')).toEqual(
        expect.objectContaining({ feeBps: 1500 }),
      );
    });

    it('无覆盖 → 全局默认 2000（CHANNEL_SHARE_FEE_BPS 缺省 20%）', () => {
      const support = makeSupport(makeBilling());
      expect(share(support, makeChannel(), 'caller-1')).toEqual(
        expect.objectContaining({ feeBps: 2000 }),
      );
    });

    it('全局默认读 env：CHANNEL_SHARE_FEE_BPS=1500 → 1500', () => {
      const support = makeSupport(makeBilling({ CHANNEL_SHARE_FEE_BPS: '1500' }));
      expect(share(support, makeChannel(), 'caller-1')).toEqual(
        expect.objectContaining({ feeBps: 1500 }),
      );
    });

    it('全局 env 非法（非有限数）→ 回落 2000', () => {
      const support = makeSupport(makeBilling({ CHANNEL_SHARE_FEE_BPS: 'abc' }));
      expect(share(support, makeChannel(), 'caller-1')).toEqual(
        expect.objectContaining({ feeBps: 2000 }),
      );
    });

    it('全局 env 超界 → 构造时钳制到 10000', () => {
      const support = makeSupport(makeBilling({ CHANNEL_SHARE_FEE_BPS: '99999' }));
      expect(share(support, makeChannel(), 'caller-1')).toEqual(
        expect.objectContaining({ feeBps: 10000 }),
      );
    });

    it('构造时未注入 config → 默认 2000', () => {
      const billing = new BillingService({} as unknown as PrismaService);
      const support = makeSupport(billing);
      expect(share(support, makeChannel(), 'caller-1')).toEqual(
        expect.objectContaining({ feeBps: 2000 }),
      );
    });
  });
});
