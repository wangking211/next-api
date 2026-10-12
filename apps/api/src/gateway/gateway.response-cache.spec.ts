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
import { ResponseCacheService } from './response-cache.service';
import type { RedisService } from '../redis/redis.service';
import type { ChannelPricing } from '../billing/pricing.util';
import type { CachedChatRecord } from './response-cache.service';
import type { GatewayRequest } from './types';

/**
 * 精确匹配响应缓存的网关行为：
 * - 命中（temperature===0 或 cache:true）：不触达上游、按折扣落账（cached=true）、
 *   不计渠道健康度与路由信号；
 * - 未命中：正常路由，成功后把响应写回缓存（拒答不写回）；
 * - cache:false / 采样请求：整条链路零接触缓存。
 */

async function* streamOf(chunks: string[]) {
  for (const c of chunks) yield c;
}

const wait = () => new Promise<void>((r) => setImmediate(r));

function setup(opts: { balance?: number } = {}) {
  const pricing = {
    priceInput: 1,
    priceOutput: 2,
    costInput: 0.5,
    costOutput: 1,
    cacheReadPrice: 0,
    cacheWritePrice: 0,
    cacheReadCost: 0,
    cacheWriteCost: 0,
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
    getBalance: jest.fn(async () => ({ balance: opts.balance ?? 100 })),
    getUserMultiplier: jest.fn(async () => 1),
    getChannelPricing: jest.fn(async () => pricing),
  };
  const usage = { record: jest.fn(async () => undefined) };
  const health = {
    recordSuccess: jest.fn(async () => undefined),
    recordFailure: jest.fn(),
  };
  const metrics = { record: jest.fn(async () => undefined) };

  const chatNonStream = jest.fn(async () => ({
    status: 200,
    json: {
      id: 'cmpl-live',
      choices: [{ message: { role: 'assistant', content: 'pong' } }],
      usage: { promptTokens: 3, completionTokens: 4, totalTokens: 7 },
    },
  }));
  const chatStream = jest.fn(async () => ({
    status: 200,
    chunks: streamOf(['data: live-1\n\n', 'data: live-2\n\n']),
  }));
  const providers = { resolve: jest.fn(() => ({ chatNonStream, chatStream })) };

  const config = { get: (_k: string, d?: string) => d };
  const support = new ExecSupportService(
    resolver as unknown as ChannelResolverService,
    usage as unknown as UsageService,
    billing as unknown as BillingService,
    health as unknown as ChannelHealthService,
    metrics as unknown as RoutingMetricsService,
    config as unknown as ConfigService,
  );

  const store = new Map<string, string>();
  const redis = {
    client: {
      get: jest.fn(async (k: string) => store.get(k) ?? null),
      setex: jest.fn(async (k: string, _ttl: number, v: string) => {
        store.set(k, v);
        return 'OK';
      }),
    },
  };
  const respCache = new ResponseCacheService(
    config as unknown as ConfigService,
    redis as unknown as RedisService,
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
    respCache,
  );

  const ee = new EventEmitter();
  const headers: Record<string, string> = {};
  const writes: string[] = [];
  let jsonPayload: unknown = null;
  const res = {
    writableFinished: false,
    writableEnded: false,
    statusCode: 0,
    setHeader: jest.fn((k: string, v: string) => {
      headers[k] = v;
    }),
    flushHeaders: () => undefined,
    write: jest.fn((c: string) => {
      writes.push(c);
      return true;
    }),
    status(code: number) {
      this.statusCode = code;
      return this;
    },
    json(payload: unknown) {
      jsonPayload = payload;
      return this;
    },
    end() {
      this.writableEnded = true;
      this.writableFinished = true;
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
      apiKey: { id: 'k1', groupId: null, routingStrategy: null },
    },
  } as unknown as GatewayRequest;

  const cachedJson = {
    id: 'cmpl-cached',
    choices: [{ message: { role: 'assistant', content: 'pong (cached)' } }],
  };
  const record: CachedChatRecord = {
    v: 1,
    channelId: 'ch1',
    usage: { promptTokens: 3, completionTokens: 4, totalTokens: 7 },
    json: cachedJson,
  };

  return {
    executor,
    respCache,
    redis,
    store,
    usage,
    health,
    metrics,
    chatNonStream,
    chatStream,
    res,
    req,
    headers,
    writes,
    getJson: () => jsonPayload,
    record,
    channel,
  };
}

const chatBody = () => ({
  model: 'gpt-4o',
  temperature: 0,
  messages: [{ role: 'user', content: 'hi' }],
});

describe('精确匹配响应缓存（网关行为）', () => {
  it('命中（非流式）：不触达上游、回放缓存 JSON、计折扣账，不计渠道健康度/信号', async () => {
    const s = setup();
    const body = chatBody();
    await s.respCache.set(s.respCache.key('gpt-4o', body, false, ['ch1']), s.record);

    await s.executor.executeChat(s.req, s.res as unknown as Response, body, 'openai');

    expect(s.chatNonStream).not.toHaveBeenCalled();
    expect(s.getJson()).toEqual(s.record.json);
    expect(s.headers['X-Gateway-Cache']).toBe('hit');
    expect(s.res.statusCode).toBe(200);
    // 落账：cached=true、按折扣计费、用量取生成时的真实值
    expect(s.usage.record).toHaveBeenCalledWith(
      expect.objectContaining({
        cached: true,
        cacheDiscount: 0.6,
        channelId: 'ch1',
        model: 'gpt-4o',
        promptTokens: 3,
        completionTokens: 4,
        totalTokens: 7,
        status: 200,
        chargeable: true,
      }),
    );
    // 缓存命中不是渠道质量证据：健康度与路由信号一律不计
    expect(s.health.recordSuccess).not.toHaveBeenCalled();
    expect(s.health.recordFailure).not.toHaveBeenCalled();
    expect(s.metrics.record).not.toHaveBeenCalled();
  });

  it('命中（流式）：重放缓存分片、用量取生成时真实值，不计健康度/信号', async () => {
    const s = setup();
    const body = { ...chatBody(), stream: true };
    await s.respCache.set(s.respCache.key('gpt-4o', body, true, ['ch1']), {
      ...s.record,
      chunks: ['data: cached-1\n\n', 'data: cached-2\n\n'],
    });

    await s.executor.executeChat(s.req, s.res as unknown as Response, body, 'openai');

    expect(s.chatStream).not.toHaveBeenCalled();
    expect(s.writes).toEqual(['data: cached-1\n\n', 'data: cached-2\n\n']);
    expect(s.headers['X-Gateway-Cache']).toBe('hit');
    expect(s.res.writableEnded).toBe(true);
    expect(s.usage.record).toHaveBeenCalledWith(
      expect.objectContaining({ cached: true, cacheDiscount: 0.6, isStream: true, totalTokens: 7 }),
    );
    expect(s.health.recordSuccess).not.toHaveBeenCalled();
    expect(s.metrics.record).not.toHaveBeenCalled();
  });

  it('未命中（非流式）：正常路由成功后写回缓存', async () => {
    const s = setup();
    const body = chatBody();

    await s.executor.executeChat(s.req, s.res as unknown as Response, body, 'openai');

    expect(s.chatNonStream).toHaveBeenCalledTimes(1);
    expect(s.res.statusCode).toBe(200);
    expect(s.usage.record).not.toHaveBeenCalledWith(expect.objectContaining({ cached: true }));
    expect(s.health.recordSuccess).toHaveBeenCalledTimes(1);
    await wait(); // 写回在后台结算里完成
    expect(s.store.has(s.respCache.key('gpt-4o', body, false, ['ch1']))).toBe(true);
  });

  it('未命中（流式）：成功后按序写回原始分片', async () => {
    const s = setup();
    const body = { ...chatBody(), stream: true };

    await s.executor.executeChat(s.req, s.res as unknown as Response, body, 'openai');

    expect(s.chatStream).toHaveBeenCalledTimes(1);
    await wait();
    const cached = s.store.get(s.respCache.key('gpt-4o', body, true, ['ch1']));
    expect(cached).toBeDefined();
    expect(JSON.parse(cached as string).chunks).toEqual(['data: live-1\n\n', 'data: live-2\n\n']);
  });

  it('拒答不写回（缓存命中会跳过换渠道重试）', async () => {
    const s = setup();
    s.chatNonStream.mockResolvedValueOnce({
      status: 200,
      json: { id: 'cmpl-refuse', choices: [{ finish_reason: 'content_filter' }] },
    } as never);
    const body = chatBody();

    await s.executor.executeChat(s.req, s.res as unknown as Response, body, 'openai');

    await wait();
    expect(s.store.size).toBe(0);
  });

  it('cache:false 强制绕过（不读不写）', async () => {
    const s = setup();
    const body = { ...chatBody(), cache: false };
    await s.respCache.set(s.respCache.key('gpt-4o', body, false, ['ch1']), s.record);

    await s.executor.executeChat(s.req, s.res as unknown as Response, body, 'openai');

    expect(s.redis.client.get).not.toHaveBeenCalled();
    expect(s.chatNonStream).toHaveBeenCalledTimes(1);
  });

  it('采样请求（temperature>0 且未 cache:true）整条链路零接触缓存', async () => {
    const s = setup();
    const body = { ...chatBody(), temperature: 1 };

    await s.executor.executeChat(s.req, s.res as unknown as Response, body, 'openai');

    expect(s.redis.client.get).not.toHaveBeenCalled();
    expect(s.chatNonStream).toHaveBeenCalledTimes(1);
    await wait();
    expect(s.redis.client.setex).not.toHaveBeenCalled();
  });

  it('余额不足时不命中缓存（不给白嫖窗口，正常路径回 403）', async () => {
    const s = setup({ balance: 0 });
    const body = chatBody();
    await s.respCache.set(s.respCache.key('gpt-4o', body, false, ['ch1']), s.record);

    await s.executor.executeChat(s.req, s.res as unknown as Response, body, 'openai');

    // 未命中（不带 hit 头）：余额闸门把请求挡在正常路径上并回 403，绝无免费缓存响应
    expect(s.headers['X-Gateway-Cache']).toBeUndefined();
    expect(s.res.statusCode).toBe(403);
    expect(s.chatNonStream).not.toHaveBeenCalled();
    expect(s.usage.record).not.toHaveBeenCalled();
  });

  it('缓存里的生成渠道已不在当前候选 → 按 miss 处理', async () => {
    const s = setup();
    const body = chatBody();
    await s.respCache.set(s.respCache.key('gpt-4o', body, false, ['ch1']), {
      ...s.record,
      channelId: 'ch-gone',
    });

    await s.executor.executeChat(s.req, s.res as unknown as Response, body, 'openai');

    expect(s.headers['X-Gateway-Cache']).toBeUndefined();
    expect(s.chatNonStream).toHaveBeenCalledTimes(1);
  });
});
