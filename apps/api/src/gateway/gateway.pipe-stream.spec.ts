import { EventEmitter } from 'node:events';
import type { Response } from 'express';
import type { Channel } from '@prisma/client';
import { ConfigService } from '@nestjs/config';
import { ChatExecutorService } from './chat-executor.service';
import type { StreamResult } from './types';
import { ChannelResolverService } from './channel-resolver.service';
import { ProviderRegistry } from './providers/provider.registry';
import { UsageService } from '../usage/usage.service';
import { BillingService } from '../billing/billing.service';
import { ChannelHealthService } from './channel-health.service';
import { RoutingMetricsService } from './routing-metrics.service';
import { GroupsService } from '../groups/groups.service';
import { ExecSupportService } from './exec-support.service';

/**
 * D1（a）快照缺陷回归：旧 pipeStream 在 for await 循环**前**一次性读取
 * isClientClosed()，流中断开后快照仍为 false → 落账 200 且计渠道成功。
 * 修复后循环结束实时读取 → 499 + 'client closed connection' + 不计健康度。
 */
describe('pipeStream client-closed handling', () => {
  type FakeRes = {
    writableFinished: boolean;
    writableEnded: boolean;
    setHeader(k: string, v: string): void;
    flushHeaders(): void;
    write(chunk: string): boolean;
    end(): void;
    on(event: 'close', cb: () => void): unknown;
  };

  function setup() {
    const usage = { record: jest.fn() };
    const health = { recordSuccess: jest.fn(), recordFailure: jest.fn() };
    const metrics = { record: jest.fn() };
    const support = { recordOutcomes: jest.fn(async () => undefined) };
    const config = { get: (_k: string, d?: string) => d };
    const executor = new ChatExecutorService(
      {} as unknown as ChannelResolverService,
      {} as unknown as ProviderRegistry,
      usage as unknown as UsageService,
      {} as unknown as BillingService,
      health as unknown as ChannelHealthService,
      metrics as unknown as RoutingMetricsService,
      {} as unknown as GroupsService,
      support as unknown as ExecSupportService,
      config as unknown as ConfigService,
    );

    const ee = new EventEmitter();
    const res: FakeRes = {
      writableFinished: false,
      writableEnded: false,
      setHeader: () => undefined,
      flushHeaders: () => undefined,
      write: () => true,
      end() {
        this.writableEnded = true;
        this.writableFinished = true;
      },
      on(event, cb) {
        ee.on(event, cb);
        return undefined;
      },
    };

    const channel = {
      id: 'ch1',
      provider: 'openai',
      failureCount: 0,
    } as unknown as Channel;

    return { executor, usage, health, metrics, support, res: res as unknown as Response, channel };
  }

  function metaOf(channel: Channel, isClientClosed: () => boolean) {
    return {
      userId: 'u1',
      apiKeyId: 'k1',
      channel,
      model: 'm1',
      startedAt: Date.now(),
      attemptStart: Date.now(),
      promptFallback: 10,
      requestPreview: '',
      chargeable: false,
      idleMs: 0,
      abort: new AbortController(),
      isClientClosed,
      apiFormat: 'openai' as const,
    };
  }

  it('records 499 + client-closed message and skips channel health on mid-stream disconnect', async () => {
    const { executor, usage, health, metrics, res, channel } = setup();
    let disconnected = false;
    const result: StreamResult = {
      status: 200,
      chunks: (async function* () {
        yield 'data: {"choices":[{"delta":{"content":"hi"}}]}\n\n';
        disconnected = true; // 模拟流中客户端断开（close 监听置位）
        yield 'data: {"choices":[{"delta":{"content":"!"}}]}\n\n';
      })(),
    };

    await executor['pipeStream'](
      res,
      result,
      metaOf(channel, () => disconnected),
    );

    expect(usage.record).toHaveBeenCalledWith(
      expect.objectContaining({
        status: 499,
        errorMessage: 'client closed connection',
      }),
    );
    // 客户端主动断开不计入渠道健康度/路由指标
    expect(health.recordFailure).not.toHaveBeenCalled();
    expect(health.recordSuccess).not.toHaveBeenCalled();
    expect(metrics.record).not.toHaveBeenCalled();
  });

  it('records 200 + channel success on normal completion (no false 499)', async () => {
    const { executor, usage, health, res, channel } = setup();
    const result: StreamResult = {
      status: 200,
      chunks: (async function* () {
        yield 'data: {"choices":[{"delta":{"content":"hi"}}]}\n\n';
        yield 'data: [DONE]\n\n';
      })(),
    };

    await executor['pipeStream'](
      res,
      result,
      metaOf(channel, () => false),
    );

    expect(usage.record).toHaveBeenCalledWith(
      expect.objectContaining({ status: 200, errorMessage: null }),
    );
    expect(health.recordSuccess).toHaveBeenCalledWith('ch1', 0);
    expect(health.recordFailure).not.toHaveBeenCalled();
  });

  it('流收尾先结束响应，落账/健康度转后台完成（响应先行）', async () => {
    const { executor, usage, health, res, channel } = setup();
    const order: string[] = [];
    health.recordSuccess.mockImplementation(
      () =>
        new Promise<void>((r) =>
          setTimeout(() => {
            order.push('health');
            r();
          }, 10),
        ),
    );
    usage.record.mockImplementation(
      () =>
        new Promise<void>((r) =>
          setTimeout(() => {
            order.push('record');
            r();
          }, 30),
        ),
    );
    // 记录 res.end 的时刻，用于和结算完成时刻比先后
    const target = res as unknown as { end: () => void };
    const originalEnd = target.end;
    target.end = function (this: unknown) {
      order.push('end');
      return originalEnd.call(this);
    };

    const result: StreamResult = {
      status: 200,
      chunks: (async function* () {
        yield 'data: {"choices":[{"delta":{"content":"hi"}}]}\n\n';
        yield 'data: [DONE]\n\n';
      })(),
    };

    await executor['pipeStream'](
      res,
      result,
      metaOf(channel, () => false),
    );

    // 客户端已收完整个流：连接先关，不等落账（旧实现是 await 完才 end）
    expect(order).toEqual(['end']);
    await new Promise<void>((r) => setTimeout(r, 60));
    expect(order).toEqual(['end', 'health', 'record']);
    expect(usage.record).toHaveBeenCalledWith(
      expect.objectContaining({ status: 200, errorMessage: null }),
    );
  });

  it('流中断错误走统一口径记录（support.recordOutcomes），不再直写 error 计数', async () => {
    const { executor, usage, health, metrics, support, res, channel } = setup();
    const result: StreamResult = {
      status: 200,
      chunks: (async function* () {
        yield 'data: {"choices":[{"delta":{"content":"hi"}}]}\n\n';
        throw new Error('upstream stream died');
      })(),
    };

    await executor['pipeStream'](
      res,
      result,
      metaOf(channel, () => false),
    );

    expect(usage.record).toHaveBeenCalledWith(
      expect.objectContaining({ status: 500, errorMessage: 'upstream stream died' }),
    );
    // 分类与健康度落地交给共享口径（429 中途断流不计失败、拒答只降质量分、含模型级豁免）
    expect(support.recordOutcomes).toHaveBeenCalledTimes(1);
    expect(support.recordOutcomes).toHaveBeenCalledWith(
      channel,
      'm1',
      expect.objectContaining({ transient: true, signal: 'upstream stream died' }),
      expect.objectContaining({
        latencyMs: expect.any(Number),
        totalTokens: expect.any(Number),
      }),
    );
    // 执行器不再直写 health/metrics（成功路径除外）
    expect(health.recordFailure).not.toHaveBeenCalled();
    expect(metrics.record).not.toHaveBeenCalled();
  });
});
