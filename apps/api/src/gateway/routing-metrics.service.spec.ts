import { ConfigService } from '@nestjs/config';
import { RoutingMetricsService } from './routing-metrics.service';

type Cmd = { cmd: string; args: any[] };

/**
 * 记录每条 redis 命令，可按需注入 exec 返回值（queue）/ 注入故障（fail）。
 * 返回对象与 state 是同一个引用，测试里直接改 fail/queue 即可生效。
 */
function makeRedis() {
  const state: {
    fail: boolean;
    calls: Cmd[];
    queue: any[][];
    client: { multi: jest.Mock };
    multi: jest.Mock;
  } = {
    fail: false,
    calls: [],
    queue: [],
    client: undefined as any,
    multi: undefined as any,
  };
  const makeChain = () => {
    const chain: any = {};
    for (const cmd of ['pexpire', 'hincrby', 'hincrbyfloat', 'hset', 'hgetall']) {
      chain[cmd] = jest.fn((...args: any[]) => {
        state.calls.push({ cmd, args });
        return chain;
      });
    }
    chain.exec = jest.fn(async () => {
      if (state.fail) throw new Error('connection refused');
      return state.queue.length ? state.queue.shift() : [];
    });
    return chain;
  };
  state.multi = jest.fn(() => makeChain());
  state.client = { multi: state.multi };
  return state;
}

const cfg = (vars: Record<string, string> = {}) =>
  ({
    get: (k: string, d?: string) => (k in vars ? vars[k] : d),
  }) as unknown as ConfigService;

const find = (calls: Cmd[], cmd: string, pred: (a: any[]) => boolean) =>
  calls.find((c) => c.cmd === cmd && pred(c.args));

describe('RoutingMetricsService', () => {
  it('records success: window + daily counters + closes the circuit', async () => {
    const r = makeRedis();
    const svc = new RoutingMetricsService(r as any, cfg());
    await svc.record('ch1', 'm', 'ok', {
      latencyMs: 1200,
      completionTokens: 42,
      totalTokens: 142,
      status: 200,
    });

    expect(find(r.calls, 'hincrby', (a) => a[1] === 'ok')).toBeDefined();
    expect(find(r.calls, 'hincrby', (a) => a[1] === 'l2')).toBeDefined(); // 1200ms → 1~3s 桶
    expect(find(r.calls, 'hincrby', (a) => a[1] === 'valid')).toBeDefined();
    expect(
      find(
        r.calls,
        'hincrby',
        (a) => String(a[0]).startsWith('route:d:ch1:') && a[1] === 'req' && a[2] === 1,
      ),
    ).toBeDefined();
    expect(
      find(
        r.calls,
        'hincrby',
        (a) => String(a[0]).startsWith('route:d:ch1:') && a[1] === 'tok' && a[2] === 142,
      ),
    ).toBeDefined();
    expect(
      find(
        r.calls,
        'hset',
        (a) => String(a[0]).startsWith('route:c:') && a[1] === 'cf' && a[2] === 0,
      ),
    ).toBeDefined();
  });

  it('counts empty-output successes as invalid replies', async () => {
    const r = makeRedis();
    const svc = new RoutingMetricsService(r as any, cfg());
    await svc.record('ch1', 'm', 'ok', { latencyMs: 300, completionTokens: 0, status: 200 });
    expect(find(r.calls, 'hincrby', (a) => a[1] === 'inval')).toBeDefined();
    expect(find(r.calls, 'hincrby', (a) => a[1] === 'valid')).toBeUndefined();
  });

  it('records refusal without touching failure/circuit counters', async () => {
    const r = makeRedis();
    const svc = new RoutingMetricsService(r as any, cfg());
    await svc.record('ch1', 'm', 'refused', {
      latencyMs: 400,
      status: 400,
      errorMessage: 'content_policy_violation',
    });
    expect(find(r.calls, 'hincrby', (a) => a[1] === 'refuse')).toBeDefined();
    expect(find(r.calls, 'hincrby', (a) => a[1] === 'fail')).toBeUndefined();
    expect(find(r.calls, 'hset', (a) => String(a[0]).startsWith('route:c:'))).toBeUndefined();
  });

  it('does not open the circuit below the failure threshold', async () => {
    const r = makeRedis();
    const svc = new RoutingMetricsService(r as any, cfg());
    r.queue.push([[null, 2]]); // circuit multi → cf = 2 < 3
    await svc.record('ch1', 'm', 'error', { latencyMs: 900, status: 500 });
    expect(find(r.calls, 'hincrby', (a) => a[1] === 'fail')).toBeDefined();
    expect(
      find(r.calls, 'hset', (a) => String(a[0]).startsWith('route:c:') && a[1] === 'cdexp'),
    ).toBeUndefined();
  });

  it('opens the circuit once consecutive failures reach the threshold', async () => {
    const r = makeRedis();
    const svc = new RoutingMetricsService(r as any, cfg({ CHANNEL_MODEL_FAILURE_THRESHOLD: '3' }));
    r.queue.push([[null, 3]]);
    await svc.record('ch1', 'm', 'error', { latencyMs: 900, status: 503 });
    const hset = find(
      r.calls,
      'hset',
      (a) => String(a[0]).startsWith('route:c:') && a[1] === 'cdexp',
    );
    expect(hset).toBeDefined();
    expect(Number(hset!.args[2])).toBeGreaterThanOrEqual(Date.now() + 59000);
  });

  it('rate limited: escalates cooldown by consecutive 429 count', async () => {
    const r = makeRedis();
    const svc = new RoutingMetricsService(
      r as any,
      cfg({ CHANNEL_RATE_LIMIT_BASE_MS: '30000', CHANNEL_MODEL_COOLDOWN_MAX_MS: '600000' }),
    );
    r.queue.push([[null, 2]]); // r429 → n=2 → 30s * 2^1 = 60s
    const before = Date.now();
    await svc.record('ch1', 'm', 'rate_limited', {
      latencyMs: 200,
      status: 429,
      errorMessage: 'rate limit exceeded',
    });
    const hset = find(
      r.calls,
      'hset',
      (a) => String(a[0]).startsWith('route:c:') && a[1] === 'cdexp',
    );
    expect(hset).toBeDefined();
    expect(Number(hset!.args[2])).toBeGreaterThanOrEqual(before + 60000);
    expect(Number(hset!.args[2])).toBeLessThanOrEqual(Date.now() + 60000);
    expect(find(r.calls, 'hincrby', (a) => a[1] === 'r429')).toBeDefined();
  });

  it('caps the rate-limit cooldown at the configured maximum', async () => {
    const r = makeRedis();
    const svc = new RoutingMetricsService(
      r as any,
      cfg({ CHANNEL_RATE_LIMIT_BASE_MS: '30000', CHANNEL_MODEL_COOLDOWN_MAX_MS: '600000' }),
    );
    r.queue.push([[null, 20]]); // 2^19 次方 → 必须被封顶
    const before = Date.now();
    await svc.record('ch1', 'm', 'rate_limited', { latencyMs: 100, status: 429 });
    const hset = find(
      r.calls,
      'hset',
      (a) => String(a[0]).startsWith('route:c:') && a[1] === 'cdexp',
    );
    expect(Number(hset!.args[2])).toBeLessThanOrEqual(before + 600000 + 50);
  });

  it('rate limited: waits out upstream Retry-After when it exceeds backoff', async () => {
    const r = makeRedis();
    const svc = new RoutingMetricsService(
      r as any,
      cfg({ CHANNEL_RATE_LIMIT_BASE_MS: '30000', CHANNEL_MODEL_COOLDOWN_MAX_MS: '600000' }),
    );
    r.queue.push([[null, 1]]); // 退避 30s < 上游要求 120s → 听上游的
    const before = Date.now();
    await svc.record('ch1', 'm', 'rate_limited', {
      latencyMs: 50,
      status: 429,
      retryAfterMs: 120_000,
    });
    const hset = find(
      r.calls,
      'hset',
      (a) => String(a[0]).startsWith('route:c:') && a[1] === 'cdexp',
    );
    expect(hset).toBeDefined();
    expect(Number(hset!.args[2])).toBeGreaterThanOrEqual(before + 120_000);
    expect(Number(hset!.args[2])).toBeLessThanOrEqual(Date.now() + 120_000);
  });

  it('rate limited: keeps exponential backoff when Retry-After is shorter', async () => {
    const r = makeRedis();
    const svc = new RoutingMetricsService(
      r as any,
      cfg({ CHANNEL_RATE_LIMIT_BASE_MS: '30000', CHANNEL_MODEL_COOLDOWN_MAX_MS: '600000' }),
    );
    r.queue.push([[null, 3]]); // 退避 30s * 2^2 = 120s > 上游要求 10s → 保留退避
    const before = Date.now();
    await svc.record('ch1', 'm', 'rate_limited', {
      latencyMs: 50,
      status: 429,
      retryAfterMs: 10_000,
    });
    const hset = find(
      r.calls,
      'hset',
      (a) => String(a[0]).startsWith('route:c:') && a[1] === 'cdexp',
    );
    expect(Number(hset!.args[2])).toBeGreaterThanOrEqual(before + 119_000);
    expect(Number(hset!.args[2])).toBeLessThanOrEqual(Date.now() + 120_000);
  });

  it('rate limited: clamps an absurd Retry-After to cooldownMaxMs', async () => {
    const r = makeRedis();
    const svc = new RoutingMetricsService(
      r as any,
      cfg({ CHANNEL_RATE_LIMIT_BASE_MS: '30000', CHANNEL_MODEL_COOLDOWN_MAX_MS: '600000' }),
    );
    r.queue.push([[null, 1]]);
    const before = Date.now();
    await svc.record('ch1', 'm', 'rate_limited', {
      latencyMs: 50,
      status: 429,
      retryAfterMs: 3_600_000, // 上游说等 1 小时 → 仍封顶 10 分钟
    });
    const hset = find(
      r.calls,
      'hset',
      (a) => String(a[0]).startsWith('route:c:') && a[1] === 'cdexp',
    );
    expect(Number(hset!.args[2])).toBeLessThanOrEqual(before + 600_000 + 100);
    expect(Number(hset!.args[2])).toBeGreaterThanOrEqual(before + 599_000);
  });

  it('snapshot merges buckets, circuit and daily counters', async () => {
    const r = makeRedis();
    const svc = new RoutingMetricsService(r as any, cfg());
    r.queue.push([
      [null, {}],
      [null, { ok: '5', latN: '5', latSum: '1000', l1: '5' }],
      [null, {}],
      [null, { req: '7', tok: '700' }],
    ]);
    const out = await svc.snapshot('m', ['ch1']);
    const m = out.get('ch1')!;
    expect(m.ok).toBe(5);
    expect(m.latN).toBe(5);
    expect(m.slow).toBe(0);
    expect(m.dayReq).toBe(7);
    expect(m.dayTok).toBe(700);
    expect(m.open).toBe(false);
    expect(m.halfOpen).toBe(false);
  });

  it('decays the previous window bucket', async () => {
    const r = makeRedis();
    const svc = new RoutingMetricsService(r as any, cfg());
    r.queue.push([
      [null, { ok: '10', latN: '10', l1: '10' }],
      [null, {}],
      [null, {}],
      [null, {}],
    ]);
    const out = await svc.snapshot('m', ['ch1']);
    const m = out.get('ch1')!;
    expect(m.ok).toBeGreaterThan(0);
    expect(m.ok).toBeLessThanOrEqual(10); // 衰减权重 ≤ 1
  });

  it('marks an active cooldown as open', async () => {
    const r = makeRedis();
    const svc = new RoutingMetricsService(r as any, cfg());
    r.queue.push([
      [null, {}],
      [null, {}],
      [null, { cf: '3', cdexp: String(Date.now() + 60000) }],
      [null, {}],
    ]);
    const m = (await svc.snapshot('m', ['ch1'])).get('ch1')!;
    expect(m.open).toBe(true);
    expect(m.halfOpen).toBe(false);
  });

  it('marks expired cooldown with remaining failures as half-open', async () => {
    const r = makeRedis();
    const svc = new RoutingMetricsService(r as any, cfg({ CHANNEL_MODEL_FAILURE_THRESHOLD: '3' }));
    r.queue.push([
      [null, {}],
      [null, {}],
      [null, { cf: '5', cdexp: '0' }],
      [null, {}],
    ]);
    const m = (await svc.snapshot('m', ['ch1'])).get('ch1')!;
    expect(m.open).toBe(false);
    expect(m.halfOpen).toBe(true);
  });

  it('serves snapshots from the short-lived process cache', async () => {
    const r = makeRedis();
    const svc = new RoutingMetricsService(r as any, cfg());
    r.queue.push([
      [null, {}],
      [null, {}],
      [null, {}],
      [null, {}],
    ]);
    await svc.snapshot('m', ['ch1']);
    await svc.snapshot('m', ['ch1']);
    expect(r.multi).toHaveBeenCalledTimes(1);
  });

  it('degrades to empty metrics on redis failure and backs off', async () => {
    const r = makeRedis();
    const svc = new RoutingMetricsService(r as any, cfg());
    r.fail = true;
    expect((await svc.snapshot('m', ['ch1'])).size).toBe(0);
    const calls = r.multi.mock.calls.length;
    expect((await svc.snapshot('m', ['ch1'])).size).toBe(0);
    expect(r.multi).toHaveBeenCalledTimes(calls); // 退避期内不再触碰 Redis
  });

  it('record never throws and enters backoff after a redis failure', async () => {
    const r = makeRedis();
    const svc = new RoutingMetricsService(r as any, cfg());
    r.fail = true;
    await expect(svc.record('ch1', 'm', 'ok', { latencyMs: 1 })).resolves.toBeUndefined();
    const calls = r.multi.mock.calls.length;
    await svc.record('ch1', 'm', 'ok', { latencyMs: 1 });
    expect(r.multi).toHaveBeenCalledTimes(calls);
  });
});
