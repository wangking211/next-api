import { EventEmitter } from 'node:events';
import type { Response } from 'express';
import type { Channel } from '@prisma/client';
import { ConfigService } from '@nestjs/config';
import { GatewayController } from './gateway.controller';
import type { StreamResult } from './types';
import { ChannelResolverService } from './channel-resolver.service';
import { ProviderRegistry } from './providers/provider.registry';
import { UsageService } from '../usage/usage.service';
import { BillingService } from '../billing/billing.service';
import { ChannelHealthService } from './channel-health.service';
import { RoutingMetricsService } from './routing-metrics.service';
import { GroupsService } from '../groups/groups.service';
import { VideoExecutorService } from './video-executor.service';
import { EmbeddingsExecutorService } from './embeddings-executor.service';
import { ExecSupportService } from './exec-support.service';

// @nestjs/swagger@12 仅发布 ESM 产物，jest 默认不转换 node_modules →
// 本地桩掉装饰器（仅影响本 spec，不改共享 jest 配置）
jest.mock('@nestjs/swagger', () => ({
  ApiTags: () => () => undefined,
  ApiOperation: () => () => undefined,
  ApiBearerAuth: () => () => undefined,
}));

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
    const config = { get: (_k: string, d?: string) => d };
    const controller = new GatewayController(
      {} as unknown as ChannelResolverService,
      {} as unknown as ProviderRegistry,
      usage as unknown as UsageService,
      {} as unknown as BillingService,
      health as unknown as ChannelHealthService,
      metrics as unknown as RoutingMetricsService,
      {} as unknown as GroupsService,
      {} as unknown as ExecSupportService,
      {} as unknown as VideoExecutorService,
      {} as unknown as EmbeddingsExecutorService,
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

    return { controller, usage, health, metrics, res: res as unknown as Response, channel };
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
    const { controller, usage, health, metrics, res, channel } = setup();
    let disconnected = false;
    const result: StreamResult = {
      status: 200,
      chunks: (async function* () {
        yield 'data: {"choices":[{"delta":{"content":"hi"}}]}\n\n';
        disconnected = true; // 模拟流中客户端断开（close 监听置位）
        yield 'data: {"choices":[{"delta":{"content":"!"}}]}\n\n';
      })(),
    };

    await controller['pipeStream'](res, result, metaOf(channel, () => disconnected));

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
    const { controller, usage, health, res, channel } = setup();
    const result: StreamResult = {
      status: 200,
      chunks: (async function* () {
        yield 'data: {"choices":[{"delta":{"content":"hi"}}]}\n\n';
        yield 'data: [DONE]\n\n';
      })(),
    };

    await controller['pipeStream'](res, result, metaOf(channel, () => false));

    expect(usage.record).toHaveBeenCalledWith(
      expect.objectContaining({ status: 200, errorMessage: null }),
    );
    expect(health.recordSuccess).toHaveBeenCalledWith('ch1', 0);
    expect(health.recordFailure).not.toHaveBeenCalled();
  });
});
