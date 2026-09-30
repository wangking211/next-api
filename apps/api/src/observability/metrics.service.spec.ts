import { MetricsService } from './metrics.service';

describe('MetricsService', () => {
  let svc: MetricsService;

  beforeEach(() => {
    svc = new MetricsService();
  });

  it('HTTP 指标按路由模板记录次数与耗时', async () => {
    svc.observeHttp('GET', '/api/users', 200, 0.012);
    svc.observeHttp('POST', '/v1/chat/completions', 500, 1.5);
    const text = await svc.render();

    expect(text).toMatch(
      /http_requests_total\{[^}]*route="\/api\/users"[^}]*\} 1/,
    );
    expect(text).toMatch(
      /http_requests_total\{[^}]*route="\/v1\/chat\/completions"[^}]*status="500"[^}]*\} 1/,
    );
    expect(text).toMatch(
      /http_request_duration_seconds_count\{[^}]*route="\/v1\/chat\/completions"[^}]*\} 1/,
    );
    expect(text).toMatch(/http_request_duration_seconds_sum\{[^}]*route="\/api\/users"[^}]*\} 0\.012/);
  });

  it('未匹配路由归入 __unmatched__', async () => {
    svc.observeHttp('GET', '__unmatched__', 404, 0.001);
    const text = await svc.render();
    expect(text).toMatch(/http_requests_total\{[^}]*route="__unmatched__"[^}]*status="404"[^}]*\} 1/);
  });

  it('网关指标：模型请求/tokens/费用', async () => {
    svc.recordGateway({
      model: 'gpt-4o-mini',
      status: 200,
      promptTokens: 10,
      completionTokens: 5,
      costUsd: 1.5,
      chargeable: true,
    });
    const text = await svc.render();
    expect(text).toMatch(/gateway_requests_total\{[^}]*model="gpt-4o-mini"[^}]*\} 1/);
    expect(text).toContain('gateway_tokens_total{kind="prompt"} 10');
    expect(text).toContain('gateway_tokens_total{kind="completion"} 5');
    expect(text).toContain('gateway_cost_usd_total{chargeable="true"} 1.5');
  });

  it('BYOK（未扣费）不计入费用，0 值 tokens 不累加', async () => {
    svc.recordGateway({
      model: 'claude-x',
      status: 200,
      promptTokens: 0,
      completionTokens: 0,
      costUsd: 0,
      chargeable: false,
    });
    const text = await svc.render();
    expect(text).toMatch(/gateway_requests_total\{[^}]*model="claude-x"[^}]*\} 1/);
    expect(text).not.toContain('gateway_cost_usd_total{chargeable="false"}');
    expect(text).not.toContain('kind="prompt"');
  });

  it('超限的自定义模型名归入 __other__（防基数爆炸）', async () => {
    for (let i = 0; i < 350; i++) {
      svc.recordGateway({
        model: `custom-model-${i}`,
        status: 200,
        promptTokens: 1,
        completionTokens: 1,
        costUsd: 0.01,
        chargeable: true,
      });
    }
    const text = await svc.render();
    const series = text.match(/^gateway_requests_total\{/gm) ?? [];
    expect(series.length).toBe(301); // 300 个模型 + __other__
    expect(text).toMatch(/gateway_requests_total\{[^}]*model="__other__"[^}]*\} 50/);
  });

  it('看门狗指标与 uptime、默认 nodejs 指标', async () => {
    svc.setServiceUp('db', false);
    svc.setServiceUp('redis', true);
    svc.setCertExpiryDays('xiaopuyun.com', 12);
    const text = await svc.render();
    expect(text).toContain('service_up{component="db"} 0');
    expect(text).toContain('service_up{component="redis"} 1');
    expect(text).toContain('cert_expiry_days{host="xiaopuyun.com"} 12');
    expect(text).toMatch(/process_uptime_seconds \d+(\.\d+)?/);
    expect(text).toContain('nodejs_heap_size_used_bytes');
  });
});
