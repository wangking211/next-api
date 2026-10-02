import { ConfigService } from '@nestjs/config';
import { ChannelOwnerType, ChannelShareMode } from '@prisma/client';
import type { Channel } from '@prisma/client';
import { GatewayController } from './gateway.controller';
import { ChannelResolverService } from './channel-resolver.service';
import { ProviderRegistry } from './providers/provider.registry';
import { UsageService } from '../usage/usage.service';
import { BillingService } from '../billing/billing.service';
import { PrismaService } from '../prisma/prisma.service';
import { ChannelHealthService } from './channel-health.service';
import { RoutingMetricsService } from './routing-metrics.service';
import { GroupsService } from '../groups/groups.service';
import { VideoTaskService } from './video-task.service';

// @nestjs/swagger@12 仅发布 ESM 产物，jest 默认不转换 node_modules →
// 本地桩掉装饰器（仅影响本 spec，同 gateway.pipe-stream.spec.ts）
jest.mock('@nestjs/swagger', () => ({
  ApiTags: () => () => undefined,
  ApiOperation: () => () => undefined,
  ApiBearerAuth: () => () => undefined,
}));

/**
 * shareContext + isSharedFromOthers + BillingService.channelShareFeeBps 行为特征化：
 * 该链路决定「他人调用我的共享渠道」时渠道主按什么比例分成——口径必须钉死。
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

function makeController(billing: BillingService) {
  const config = { get: (_key: string, def?: string) => def };
  return new GatewayController(
    {} as unknown as ChannelResolverService,
    {} as unknown as ProviderRegistry,
    {} as unknown as UsageService,
    billing,
    {} as unknown as ChannelHealthService,
    {} as unknown as RoutingMetricsService,
    {} as unknown as GroupsService,
    {} as unknown as VideoTaskService,
    config as unknown as ConfigService,
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

/** 私有方法经元素访问调用（与 gateway.pipe-stream.spec.ts 的 pipeStream 同法） */
function share(controller: GatewayController, channel: Channel, callerUserId: string) {
  return controller['shareContext'](channel, callerUserId);
}

describe('GatewayController.shareContext（共享分成上下文，行为特征化）', () => {
  describe('isSharedFromOthers 判定', () => {
    it('调用者即渠道主 → undefined（自有渠道走 BYOK，不分成）', () => {
      const controller = makeController(makeBilling());
      expect(share(controller, makeChannel(), 'owner-1')).toBeUndefined();
    });

    it('平台渠道（ownerType=PLATFORM）→ undefined（平台渠道无分成对象）', () => {
      const controller = makeController(makeBilling());
      const channel = makeChannel({ ownerType: ChannelOwnerType.PLATFORM });
      expect(share(controller, channel, 'caller-1')).toBeUndefined();
    });

    it('他人 PUBLIC 共享渠道 → { ownerUserId, feeBps }', () => {
      const controller = makeController(makeBilling());
      expect(share(controller, makeChannel(), 'caller-1')).toEqual({
        ownerUserId: 'owner-1',
        feeBps: 2000,
      });
    });

    it('shareMode=GROUP 同样视为共享（判定只排除 PRIVATE）', () => {
      const controller = makeController(makeBilling());
      const channel = makeChannel({ shareMode: ChannelShareMode.GROUP });
      expect(share(controller, channel, 'caller-1')).toEqual({
        ownerUserId: 'owner-1',
        feeBps: 2000,
      });
    });

    it('shareMode=PRIVATE → undefined（未开放共享，即便 owner 是他人）', () => {
      const controller = makeController(makeBilling());
      const channel = makeChannel({ shareMode: ChannelShareMode.PRIVATE });
      expect(share(controller, channel, 'caller-1')).toBeUndefined();
    });

    it('ownerUserId 缺失 → undefined（USER 渠道孤儿行防御）', () => {
      const controller = makeController(makeBilling());
      const channel = makeChannel({ ownerUserId: null });
      expect(share(controller, channel, 'caller-1')).toBeUndefined();
    });

    it('共享场景返回的 ownerUserId 即渠道主', () => {
      const controller = makeController(makeBilling());
      const channel = makeChannel({ ownerUserId: 'owner-42' });
      expect(share(controller, channel, 'caller-1')).toEqual(
        expect.objectContaining({ ownerUserId: 'owner-42' }),
      );
    });
  });

  describe('feeBps 协作（真实 BillingService.channelShareFeeBps）', () => {
    it('feeBps 取自 billing.channelShareFeeBps(channel)，非硬编码', () => {
      const billing = makeBilling();
      const spy = jest.spyOn(billing, 'channelShareFeeBps');
      const controller = makeController(billing);
      const channel = makeChannel({ shareFeeBps: 500 });
      expect(share(controller, channel, 'caller-1')).toEqual({
        ownerUserId: 'owner-1',
        feeBps: 500,
      });
      expect(spy).toHaveBeenCalledWith(channel);
    });

    it('每渠道覆盖优先于全局默认（env=1500、渠道=500 → 500）', () => {
      const controller = makeController(makeBilling({ CHANNEL_SHARE_FEE_BPS: '1500' }));
      expect(share(controller, makeChannel({ shareFeeBps: 500 }), 'caller-1')).toEqual(
        expect.objectContaining({ feeBps: 500 }),
      );
    });

    it('每渠道覆盖 shareFeeBps=0 被保留（nullish 合并不把 0 当缺省）', () => {
      const controller = makeController(makeBilling({ CHANNEL_SHARE_FEE_BPS: '1500' }));
      expect(share(controller, makeChannel({ shareFeeBps: 0 }), 'caller-1')).toEqual(
        expect.objectContaining({ feeBps: 0 }),
      );
    });

    it('覆盖超上界钳制：99999 → 10000（满抽 100%）', () => {
      const controller = makeController(makeBilling());
      const channel = makeChannel({ shareFeeBps: 99999 });
      expect(share(controller, channel, 'caller-1')).toEqual(
        expect.objectContaining({ feeBps: 10000 }),
      );
    });

    it('覆盖为负钳制：-5 → 0', () => {
      const controller = makeController(makeBilling());
      const channel = makeChannel({ shareFeeBps: -5 });
      expect(share(controller, channel, 'caller-1')).toEqual(
        expect.objectContaining({ feeBps: 0 }),
      );
    });

    it('非整数覆盖向下取整：1500.9 → 1500', () => {
      const controller = makeController(makeBilling());
      const channel = makeChannel({ shareFeeBps: 1500.9 });
      expect(share(controller, channel, 'caller-1')).toEqual(
        expect.objectContaining({ feeBps: 1500 }),
      );
    });

    it('无覆盖 → 全局默认 2000（CHANNEL_SHARE_FEE_BPS 缺省 20%）', () => {
      const controller = makeController(makeBilling());
      expect(share(controller, makeChannel(), 'caller-1')).toEqual(
        expect.objectContaining({ feeBps: 2000 }),
      );
    });

    it('全局默认读 env：CHANNEL_SHARE_FEE_BPS=1500 → 1500', () => {
      const controller = makeController(makeBilling({ CHANNEL_SHARE_FEE_BPS: '1500' }));
      expect(share(controller, makeChannel(), 'caller-1')).toEqual(
        expect.objectContaining({ feeBps: 1500 }),
      );
    });

    it('全局 env 非法（非有限数）→ 回落 2000', () => {
      const controller = makeController(makeBilling({ CHANNEL_SHARE_FEE_BPS: 'abc' }));
      expect(share(controller, makeChannel(), 'caller-1')).toEqual(
        expect.objectContaining({ feeBps: 2000 }),
      );
    });

    it('全局 env 超界 → 构造时钳制到 10000', () => {
      const controller = makeController(makeBilling({ CHANNEL_SHARE_FEE_BPS: '99999' }));
      expect(share(controller, makeChannel(), 'caller-1')).toEqual(
        expect.objectContaining({ feeBps: 10000 }),
      );
    });

    it('构造时未注入 config → 默认 2000', () => {
      const billing = new BillingService({} as unknown as PrismaService);
      const controller = makeController(billing);
      expect(share(controller, makeChannel(), 'caller-1')).toEqual(
        expect.objectContaining({ feeBps: 2000 }),
      );
    });
  });
});
