import { EventEmitter } from 'node:events';
import type { Response } from 'express';
import { ChannelOwnerType, ChannelShareMode } from '@prisma/client';
import type { Channel } from '@prisma/client';
import { ConfigService } from '@nestjs/config';
import { ChatExecutorService } from './chat-executor.service';
import { ExecSupportService } from './exec-support.service';
import { ChannelResolverService } from './channel-resolver.service';
import { ProviderRegistry } from './providers/provider.registry';
import { UsageService } from '../usage/usage.service';
import { BillingService } from '../billing/billing.service';
import { ChannelHealthService } from './channel-health.service';
import { RoutingMetricsService } from './routing-metrics.service';
import { GroupsService } from '../groups/groups.service';
import type { ChannelPricing } from '../billing/pricing.util';
import type { GatewayRequest } from './types';
import { UpstreamError } from './types';

/**
 * 响应先行（settleInBackground）回归：一次落账 = DB 事务 + 日聚合 + Redis 写，
 * 挡在响应前面就是把上游已经返回的结果白等几十毫秒。
 *
 * 手法：把 usage.record / health.recordSuccess 换成「延迟完成」的实现，记录
 * 「响应写入」与「结算完成」的先后顺序。旧实现是 await 完结算再写响应，
 * 顺序会变成 health/record 在 response 之前，用例即失败。
 */

const wait = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

function setup() {
  /** 响应写入与结算完成都往这里追加，用顺序断言先后 */
  const order: string[] = [];

  const pricing = {
    priceInput: 1,
    priceOutput: 2,
    costInput: 0.5,
    costOutput: 1,
    cacheReadPrice: 0.1,
    cacheWritePrice: 0.125,
    cacheReadCost: 0.05,
    cacheWriteCost: 0.0625,
    pricePerCall: 0,
    costPerCall: 0,
  } as ChannelPricing;

  const channel = {
    id: 'ch1',
    provider: 'openai',
    ownerType: ChannelOwnerType.PLATFORM,
    shareMode: ChannelShareMode.PRIVATE,
    ownerUserId: null,
    failureCount: 0,
  } as unknown as Channel;

  const resolver = {
    resolveAlias: jest.fn(async (m: string) => m),
    resolve: jest.fn(async () => [{ channel, apiKey: 'sk-up', upstreamModelName: null, pricing }]),
    catalogFor: jest.fn(async () => new Map()),
  };
  const groups = {
    effectiveGroup: jest.fn(async () => ({ id: 'g1', ratio: 1 })),
    isModelVisible: jest.fn(() => true),
  };
  const billing = {
    getBillingMultiplier: jest.fn(async () => ({ value: 1, source: 'plan' })),
    getBalance: jest.fn(async () => ({ balance: 100 })),
    getUserMultiplier: jest.fn(async () => 1),
    getChannelPricing: jest.fn(async () => pricing),
  };
  // 落账最慢（30ms）、健康度次之（10ms），完成时各记一笔
  const usage = {
    record: jest.fn(
      () =>
        new Promise<void>((r) =>
          setTimeout(() => {
            order.push('record');
            r();
          }, 30),
        ),
    ),
  };
  const health = {
    recordSuccess: jest.fn(
      () =>
        new Promise<void>((r) =>
          setTimeout(() => {
            order.push('health');
            r();
          }, 10),
        ),
    ),
    recordFailure: jest.fn(),
  };
  const metrics = { record: jest.fn(async () => undefined) };

  const chatNonStream = jest.fn(async () => ({
    status: 200,
    json: {
      id: 'cmpl-1',
      choices: [{ message: { role: 'assistant', content: 'pong' } }],
      usage: { promptTokens: 3, completionTokens: 4, totalTokens: 7 },
    },
  }));
  const providers = { resolve: jest.fn(() => ({ chatNonStream })) };

  const config = { get: (_k: string, d?: string) => d };
  const support = new ExecSupportService(
    resolver as unknown as ChannelResolverService,
    usage as unknown as UsageService,
    billing as unknown as BillingService,
    health as unknown as ChannelHealthService,
    metrics as unknown as RoutingMetricsService,
  );
  const executor = new ChatExecutorService(
    resolver as unknown as ChannelResolverService,
    providers as unknown as ProviderRegistry,
    usage as unknown as UsageService,
    billing as unknown as BillingService,
    health as unknown as ChannelHealthService,
    metrics as unknown as RoutingMetricsService,
    groups as unknown as GroupsService,
    support,
    config as unknown as ConfigService,
  );

  const ee = new EventEmitter();
  const res = {
    writableFinished: false,
    writableEnded: false,
    statusCode: 0,
    setHeader: () => undefined,
    flushHeaders: () => undefined,
    write: () => true,
    status(code: number) {
      this.statusCode = code;
      return this;
    },
    json(_payload: unknown) {
      order.push('response');
      return this;
    },
    end() {
      this.writableEnded = true;
      this.writableFinished = true;
      order.push('response');
    },
    on(event: string, cb: () => void) {
      ee.on(event, cb);
      return undefined;
    },
  };

  const req = {
    headers: {},
    gateway: {
      user: { id: 'u1' },
      apiKey: { groupId: null, routingStrategy: null },
    },
  } as unknown as GatewayRequest;

  return { executor, support, order, usage, health, res, req, channel, pricing };
}

describe('响应先行（结算转后台）', () => {
  it('非流式 chat：响应先给客户端，落账/健康度随后在后台完成', async () => {
    const s = setup();
    await s.executor.executeChat(
      s.req,
      s.res as unknown as Response,
      { model: 'gpt-4o', stream: false, messages: [{ role: 'user', content: 'hi' }] },
      'openai',
    );
    // 响应已写出，而 30ms 才完成的落账/10ms 才完成的健康度都还没回来
    expect(s.order).toEqual(['response']);
    expect(s.usage.record).toHaveBeenCalledTimes(1);
    expect(s.health.recordSuccess).toHaveBeenCalledTimes(1);

    await wait(60);
    expect(s.order).toEqual(['response', 'health', 'record']);
  });

  it('错误路径：错误响应先写出，落账不再挡在前面', async () => {
    const s = setup();
    const action = await s.support.handleUpstreamFailure(
      new UpstreamError('upstream boom', 502, true),
      {
        res: s.res as unknown as Response,
        channel: s.channel,
        model: 'gpt-4o',
        attemptStart: Date.now(),
        startedAt: Date.now(),
        userId: 'u1',
        apiKeyId: 'k1',
        requestPreview: '',
        isStream: false,
        hasMore: false, // 无下一个候选 → 落账并写出错误响应（否则继续故障转移）
        pricing: s.pricing,
        multiplier: 1,
        multiplierSource: 'plan',
        errorBody: (message: string) => ({ error: { message } }),
      },
    );
    expect(action).toBe('responded');
    expect(s.order).toEqual(['response']);

    await wait(60);
    expect(s.order).toEqual(['response', 'record']);
  });

  it('后台结算失败不产生未处理拒绝（allSettled 兜底）', async () => {
    const unhandled: unknown[] = [];
    const onUnhandled = (e: unknown) => unhandled.push(e);
    process.on('unhandledRejection', onUnhandled);
    try {
      const s = setup();
      s.usage.record.mockImplementation(() => Promise.reject(new Error('db down')));
      await s.executor.executeChat(
        s.req,
        s.res as unknown as Response,
        { model: 'gpt-4o', stream: false, messages: [{ role: 'user', content: 'hi' }] },
        'openai',
      );
      await wait(30); // 给事件循环足够轮次让可能的 rejection 冒出来
      expect(unhandled).toEqual([]);
      // 响应已写出；被拒绝的 record 永远不会记一笔，也没有冒成未处理拒绝
      expect(s.order[0]).toBe('response');
      expect(s.order).not.toContain('record');
    } finally {
      process.off('unhandledRejection', onUnhandled);
    }
  });
});
