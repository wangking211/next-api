import { Channel } from '@prisma/client';
import { ExecSupportService } from './exec-support.service';
import { BillingService } from '../billing/billing.service';
import { UsageService } from '../usage/usage.service';
import { ChannelResolverService } from './channel-resolver.service';
import { ChannelHealthService } from './channel-health.service';
import { RoutingMetricsService } from './routing-metrics.service';
import { UpstreamError } from './types';

/** 与 openaiError 同形：err(message, type, code) */
function err(message: string, type = 'invalid_request_error', code: string | null = null) {
  return { error: { message, type, code } };
}

function makeSupport(capabilities: string[] = ['tools', 'vision', 'embeddings']) {
  const resolver = {
    catalogFor: jest.fn(async () => new Map([['m', { name: 'm', capabilities }]])),
  };
  const usage = { record: jest.fn() };
  const billing = {};
  const health = { recordRateLimited: jest.fn(), recordFailure: jest.fn() };
  const metrics = { record: jest.fn() };
  const support = new ExecSupportService(
    resolver as unknown as ChannelResolverService,
    usage as unknown as UsageService,
    billing as unknown as BillingService,
    health as unknown as ChannelHealthService,
    metrics as unknown as RoutingMetricsService,
  );
  const res = {
    statusCode: 0,
    payload: undefined as any,
    status(code: number) {
      this.statusCode = code;
      return this;
    },
    json(p: any) {
      this.payload = p;
      return this;
    },
  };
  return { support, resolver, health, metrics, res };
}

describe('ExecSupportService.checkCapabilities（能力路由）', () => {
  it('请求不需要任何能力 → 放行且不查目录', async () => {
    const { support, resolver, res } = makeSupport(['tools']);
    const ok = await support.checkCapabilities(
      'm',
      { messages: [{ role: 'user', content: 'hi' }] },
      res as any,
      err,
    );
    expect(ok).toBe(true);
    expect(resolver.catalogFor).not.toHaveBeenCalled();
    expect(res.statusCode).toBe(0);
  });

  it('目录未声明能力（空数组 = 未标注）→ 放行，不误杀', async () => {
    const { support, res } = makeSupport([]);
    const ok = await support.checkCapabilities(
      'm',
      { messages: [{ role: 'user', content: [{ type: 'image_url', image_url: { url: 'u' } }] }] },
      res as any,
      err,
    );
    expect(ok).toBe(true);
    expect(res.statusCode).toBe(0);
  });

  it('声明了能力但请求所需能力缺失 → 400 capability_not_supported（英文消息）', async () => {
    const { support, res } = makeSupport(['vision']);
    const ok = await support.checkCapabilities(
      'm',
      { messages: [], tools: [{ type: 'function' }] },
      res as any,
      err,
    );
    expect(ok).toBe(false);
    expect(res.statusCode).toBe(400);
    expect(res.payload.error.type).toBe('invalid_request_error');
    expect(res.payload.error.code).toBe('capability_not_supported');
    expect(res.payload.error.message).toContain('does not support: tools');
    expect(res.payload.error.message).toContain('Declared capabilities: vision');
  });

  it('所需能力被声明覆盖 → 放行', async () => {
    const { support, res } = makeSupport(['tools', 'vision']);
    const ok = await support.checkCapabilities(
      'm',
      {
        messages: [{ role: 'user', content: [{ type: 'image_url', image_url: { url: 'u' } }] }],
        tools: [{ type: 'function' }],
      },
      res as any,
      err,
    );
    expect(ok).toBe(true);
    expect(res.statusCode).toBe(0);
  });

  it('embeddings 调用体需要 embeddings 能力', async () => {
    const { support, res } = makeSupport(['tools', 'vision']);
    const ok = await support.checkCapabilities('m', { input: 'hello' }, res as any, err);
    expect(ok).toBe(false);
    expect(res.statusCode).toBe(400);
    expect(res.payload.error.message).toContain('does not support: embeddings');
  });
});

describe('ExecSupportService.handleUpstreamFailure（429 透传 Retry-After）', () => {
  it('limited 且有下家：记录 retryAfterMs 并故障转移到下一家', async () => {
    const { support, health, metrics, res } = makeSupport();
    const e = new UpstreamError(
      'Upstream error 429',
      429,
      true,
      { error: { message: 'rate limit exceeded' } },
      120_000,
    );
    const action = await support.handleUpstreamFailure(e, {
      res: res as any,
      channel: { id: 'ch1' } as unknown as Channel,
      model: 'm',
      attemptStart: Date.now() - 10,
      startedAt: Date.now() - 100,
      userId: 'u1',
      apiKeyId: 'k1',
      requestPreview: '',
      isStream: false,
      hasMore: true,
      errorBody: err,
    });
    expect(action).toBe('continue');
    expect(health.recordRateLimited).toHaveBeenCalledWith('ch1', expect.any(String));
    expect(metrics.record).toHaveBeenCalledWith(
      'ch1',
      'm',
      'rate_limited',
      expect.objectContaining({ status: 429, retryAfterMs: 120_000 }),
    );
  });

  it('未带 Retry-After 的 429 → retryAfterMs 为 undefined（回退自身指数退避）', async () => {
    const { support, metrics, res } = makeSupport();
    const e = new UpstreamError('Upstream error 429', 429, true, {
      error: { message: 'rate limit exceeded' },
    });
    await support.handleUpstreamFailure(e, {
      res: res as any,
      channel: { id: 'ch1' } as unknown as Channel,
      model: 'm',
      attemptStart: Date.now() - 10,
      startedAt: Date.now() - 100,
      userId: 'u1',
      apiKeyId: 'k1',
      requestPreview: '',
      isStream: false,
      hasMore: true,
      errorBody: err,
    });
    expect(metrics.record).toHaveBeenCalledWith(
      'ch1',
      'm',
      'rate_limited',
      expect.objectContaining({ retryAfterMs: undefined }),
    );
  });
});
