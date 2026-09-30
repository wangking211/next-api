import { Injectable } from '@nestjs/common';
import {
  Counter,
  Gauge,
  Histogram,
  Registry,
  collectDefaultMetrics,
} from 'prom-client';

/** HTTP 耗时直方图分桶（秒）；网关流式请求可能远超 10s，落在 +Inf 桶 */
const HTTP_DURATION_BUCKETS = [0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10, 30];

/** 自定义模型名标签上限：BYOK 渠道可自定义模型名，超限后归入 __other__，防指标基数爆炸 */
const MODEL_LABEL_CAP = 300;

export interface GatewayRecordInput {
  model: string;
  status: number;
  promptTokens: number;
  completionTokens: number;
  /** 实扣费用（USD，含倍率；BYOK 为 0） */
  costUsd: number;
  chargeable: boolean;
}

/**
 * Prometheus 指标（/api/metrics）。
 *
 * - nodejs_* / process_* 为 prom-client 默认指标（CPU、内存、事件循环、GC、句柄）
 * - HTTP 层按「路由模板」而非原始 URL 打点，避免 /api/usage/logs/:id 之类的高基数
 * - 网关层在用量落库漏斗（UsageService.record）埋点：模型名已被目录/渠道校验过
 */
@Injectable()
export class MetricsService {
  private readonly registry = new Registry();
  private readonly httpRequests: Counter<'method' | 'route' | 'status'>;
  private readonly httpDuration: Histogram<'method' | 'route'>;
  private readonly gatewayRequests: Counter<'model' | 'status'>;
  private readonly gatewayTokens: Counter<'kind'>;
  private readonly gatewayCost: Counter<'chargeable'>;
  private readonly serviceUp: Gauge<'component'>;
  private readonly certExpiryDays: Gauge<'host'>;
  private readonly uptime: Gauge<never>;
  private readonly modelsSeen = new Set<string>();

  constructor() {
    collectDefaultMetrics({ register: this.registry });

    this.uptime = new Gauge({
      name: 'process_uptime_seconds',
      help: 'Process uptime in seconds',
      registers: [this.registry],
    });
    this.httpRequests = new Counter({
      name: 'http_requests_total',
      help: 'Total HTTP requests by method, matched route and status',
      labelNames: ['method', 'route', 'status'],
      registers: [this.registry],
    });
    this.httpDuration = new Histogram({
      name: 'http_request_duration_seconds',
      help: 'HTTP request duration in seconds by method and matched route',
      labelNames: ['method', 'route'],
      buckets: HTTP_DURATION_BUCKETS,
      registers: [this.registry],
    });
    this.gatewayRequests = new Counter({
      name: 'gateway_requests_total',
      help: 'Gateway requests recorded in usage logs, by model and status',
      labelNames: ['model', 'status'],
      registers: [this.registry],
    });
    this.gatewayTokens = new Counter({
      name: 'gateway_tokens_total',
      help: 'Gateway tokens by kind (prompt/completion)',
      labelNames: ['kind'],
      registers: [this.registry],
    });
    this.gatewayCost = new Counter({
      name: 'gateway_cost_usd_total',
      help: 'Gateway billed cost in USD (positive values only)',
      labelNames: ['chargeable'],
      registers: [this.registry],
    });
    this.serviceUp = new Gauge({
      name: 'service_up',
      help: 'Dependency health observed by the watchdog (1 = up, 0 = down)',
      labelNames: ['component'],
      registers: [this.registry],
    });
    this.certExpiryDays = new Gauge({
      name: 'cert_expiry_days',
      help: 'Days until TLS certificate expiry (-1 = check failed)',
      labelNames: ['host'],
      registers: [this.registry],
    });
  }

  /** HTTP 中间件：记录次数与耗时；route 为 express 路由模板（未匹配则 __unmatched__） */
  observeHttp(method: string, route: string, status: number, seconds: number): void {
    this.httpRequests.inc({ method, route, status: String(status) });
    this.httpDuration.observe({ method, route }, seconds);
  }

  /** 用量落库漏斗：按模型记录请求数、tokens 与实扣费用 */
  recordGateway(input: GatewayRecordInput): void {
    this.gatewayRequests.inc({
      model: this.modelLabel(input.model),
      status: String(input.status),
    });
    if (input.promptTokens > 0) {
      this.gatewayTokens.inc({ kind: 'prompt' }, input.promptTokens);
    }
    if (input.completionTokens > 0) {
      this.gatewayTokens.inc({ kind: 'completion' }, input.completionTokens);
    }
    if (input.costUsd > 0) {
      this.gatewayCost.inc({ chargeable: String(input.chargeable) }, input.costUsd);
    }
  }

  /** 看门狗：依赖健康度（db / redis） */
  setServiceUp(component: string, up: boolean): void {
    this.serviceUp.set({ component }, up ? 1 : 0);
  }

  /** 看门狗：证书剩余天数（-1 = 检查失败） */
  setCertExpiryDays(host: string, days: number): void {
    this.certExpiryDays.set({ host }, days);
  }

  /** Prometheus 抓取（text/plain 0.0.4）；抓取时刷新 uptime */
  async render(): Promise<string> {
    this.uptime.set(process.uptime());
    return this.registry.metrics();
  }

  private modelLabel(model: string): string {
    const m = (model || 'unknown').slice(0, 120);
    if (this.modelsSeen.has(m)) return m;
    if (this.modelsSeen.size >= MODEL_LABEL_CAP) return '__other__';
    this.modelsSeen.add(m);
    return m;
  }
}
