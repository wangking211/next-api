import { Channel } from '@prisma/client';
import { ConfigService } from '@nestjs/config';
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

function makeSupport(
  capabilities: string[] = ['tools', 'vision', 'embeddings'],
  env: Record<string, string> = {},
) {
  const resolver = {
    catalogFor: jest.fn(async () => new Map([['m', { name: 'm', capabilities }]])),
  };
  const usage = { record: jest.fn() };
  const billing = {};
  const health = {
    recordRateLimited: jest.fn(),
    recordFailure: jest.fn(),
    recordSuccess: jest.fn(),
  };
  const metrics = {
    record: jest.fn(),
    hasRecentSuccessOutside: jest.fn().mockResolvedValue(false),
  };
  const config = {
    get: (k: string, d?: string) => (k in env ? env[k] : d),
  } as unknown as ConfigService;
  const support = new ExecSupportService(
    resolver as unknown as ChannelResolverService,
    usage as unknown as UsageService,
    billing as unknown as BillingService,
    health as unknown as ChannelHealthService,
    metrics as unknown as RoutingMetricsService,
    config,
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
  return { support, resolver, health, metrics, usage, res };
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

/** 失败处理用例共用的 ctx 形态（按需覆盖 hasMore/channel） */
function failureCtx(
  s: { res: unknown },
  channel: Channel,
  hasMore: boolean,
): Parameters<ExecSupportService['handleUpstreamFailure']>[1] {
  return {
    res: s.res as any,
    channel,
    model: 'm',
    attemptStart: Date.now() - 10,
    startedAt: Date.now() - 100,
    userId: 'u1',
    apiKeyId: 'k1',
    requestPreview: '',
    isStream: false,
    hasMore,
    errorBody: err,
  };
}

describe('handleUpstreamFailure（拒答参与故障转移 + 分类边界）', () => {
  const chan = { id: 'ch1', models: ['m'] } as unknown as Channel;

  it('拒答（400 content_policy）→ 转移下一家，只降质量分、不计渠道失败', async () => {
    const s = makeSupport();
    const action = await s.support.handleUpstreamFailure(
      new UpstreamError('Upstream error 400', 400, false, {
        error: { message: 'content_policy violation', type: 'invalid_request_error' },
      }),
      failureCtx(s, chan, true),
    );
    expect(action).toBe('continue');
    expect(s.health.recordFailure).not.toHaveBeenCalled();
    expect(s.health.recordRateLimited).not.toHaveBeenCalled();
    expect(s.metrics.record).toHaveBeenCalledWith(
      'ch1',
      'm',
      'refused',
      expect.objectContaining({ status: 400 }),
    );
  });

  it('拒答（末家候选）→ 落账并返回错误响应', async () => {
    const s = makeSupport();
    const action = await s.support.handleUpstreamFailure(
      new UpstreamError('Upstream error 400', 400, false, {
        error: { message: 'safety refusal' },
      }),
      failureCtx(s, chan, false),
    );
    expect(action).toBe('responded');
    expect(s.res.statusCode).toBe(400);
    expect(s.usage.record).toHaveBeenCalled();
    expect(s.health.recordFailure).not.toHaveBeenCalled();
  });

  it('5xx 且带拒答文案 → 文案特征压过可重试状态码：不计渠道失败，仍可转移', async () => {
    const s = makeSupport();
    const action = await s.support.handleUpstreamFailure(
      new UpstreamError('Upstream error 503', 503, true, {
        error: { message: 'response blocked by content filter' },
      }),
      failureCtx(s, chan, true),
    );
    expect(action).toBe('continue');
    expect(s.health.recordFailure).not.toHaveBeenCalled();
    expect(s.metrics.record).toHaveBeenCalledWith('ch1', 'm', 'refused', expect.any(Object));
  });

  it('普通 5xx → 计渠道失败并转移', async () => {
    const s = makeSupport();
    const action = await s.support.handleUpstreamFailure(
      new UpstreamError('Upstream error 502', 502, true),
      failureCtx(s, chan, true),
    );
    expect(action).toBe('continue');
    expect(s.health.recordFailure).toHaveBeenCalledWith('ch1', expect.any(String), {
      count: true,
    });
  });
});

describe('handleUpstreamFailure（模型级故障豁免，不连坐渠道禁用）', () => {
  it('渠道其它模型窗口期内成功过 → 只记现场，不累计渠道 failureCount', async () => {
    const s = makeSupport();
    s.metrics.hasRecentSuccessOutside.mockResolvedValue(true);
    const channel = { id: 'ch1', models: ['m', 'm2'] } as unknown as Channel;
    const action = await s.support.handleUpstreamFailure(
      new UpstreamError('Upstream error 502', 502, true),
      failureCtx(s, channel, true),
    );
    expect(action).toBe('continue');
    expect(s.metrics.hasRecentSuccessOutside).toHaveBeenCalledWith('ch1', 'm');
    expect(s.health.recordFailure).toHaveBeenCalledWith('ch1', expect.any(String), {
      count: false,
    });
    // (渠道,模型) 熔断照常记录
    expect(s.metrics.record).toHaveBeenCalledWith(
      'ch1',
      'm',
      'error',
      expect.objectContaining({ status: 502 }),
    );
  });

  it('其它模型也没有成功 → 照常累计渠道失败', async () => {
    const s = makeSupport();
    s.metrics.hasRecentSuccessOutside.mockResolvedValue(false);
    const channel = { id: 'ch1', models: ['m', 'm2'] } as unknown as Channel;
    await s.support.handleUpstreamFailure(
      new UpstreamError('Upstream error 502', 502, true),
      failureCtx(s, channel, true),
    );
    expect(s.health.recordFailure).toHaveBeenCalledWith('ch1', expect.any(String), {
      count: true,
    });
  });

  it('单模型渠道 → 模型故障即渠道故障，不做成功标记查询', async () => {
    const s = makeSupport();
    const channel = { id: 'ch1', models: ['m'] } as unknown as Channel;
    await s.support.handleUpstreamFailure(
      new UpstreamError('Upstream error 502', 502, true),
      failureCtx(s, channel, true),
    );
    expect(s.metrics.hasRecentSuccessOutside).not.toHaveBeenCalled();
    expect(s.health.recordFailure).toHaveBeenCalledWith('ch1', expect.any(String), {
      count: true,
    });
  });
});

describe('ExecSupportService 整请求 deadline', () => {
  it('默认 300s 总预算，单次尝试超时钳制在 120s 内', () => {
    const { support } = makeSupport();
    expect(support.deadlineMs).toBe(300_000);
    const startedAt = Date.now();
    expect(support.deadlineLeft(startedAt)).toBeGreaterThan(290_000);
    expect(support.attemptTimeoutMs(startedAt)).toBeLessThanOrEqual(120_000);
  });

  it('预算耗尽 → deadlineLeft=0 + respondDeadline 写 504 gateway_timeout', async () => {
    const s = makeSupport([], { GATEWAY_DEADLINE_MS: '1' });
    expect(s.support.deadlineLeft(Date.now() - 50)).toBe(0);
    s.support.respondDeadline(s.res as any, err);
    expect(s.res.statusCode).toBe(504);
    expect(s.res.payload.error.code).toBe('gateway_timeout');
  });

  it('GATEWAY_DEADLINE_MS<=0 → 关闭：任意时间仍有预算，单次超时回退 120s', () => {
    const { support } = makeSupport([], { GATEWAY_DEADLINE_MS: '0' });
    expect(support.deadlineMs).toBe(0);
    expect(support.deadlineLeft(Date.now() - 999_999)).toBe(Number.POSITIVE_INFINITY);
    expect(support.attemptTimeoutMs(Date.now())).toBe(120_000);
  });
});
