import { Injectable } from '@nestjs/common';
import { Channel } from '@prisma/client';
import { PrismaService } from '../../prisma/prisma.service';
import { redactSecrets } from '../../common/redact.util';
import { Provider, UpstreamError } from '../types';
import { ProviderRegistry } from './provider.registry';
import { extractUpstreamError, redactDetail, safeStringify } from './probe.util';

export interface UpstreamProbeInput {
  provider: string;
  baseUrl: string;
  apiKey: string;
  /** 上游真实模型名（渠道×模型映射后的名字） */
  model: string;
}

export interface UpstreamProbeResult {
  ok: boolean;
  status?: number;
  latencyMs: number;
  model: string;
  provider: string;
  sample?: string;
  error?: string;
  detail?: string | null;
}

/**
 * 上游连通性探针：向指定上游发一次最小请求，返回状态与延迟。
 *
 * 只做诊断：不写 RequestLog、不产生用量与费用、不改渠道健康度
 * （渠道页「测试」与 Key 页「测试连通性」共用）。
 */
@Injectable()
export class UpstreamProbeService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly providers: ProviderRegistry,
  ) {}

  async run(input: UpstreamProbeInput): Promise<UpstreamProbeResult> {
    const provider = this.providers.resolve(input.provider);
    // 视频能力模型不支持 /chat/completions（上游回 endpoint not available），聊天探针必然
    // 误判为失败 —— 改走只读的任务状态探测（随机假任务 ID，不产生任何生成）
    if (
      (await this.modelCapabilities(input.model)).includes('video') &&
      typeof provider.videoStatus === 'function'
    ) {
      return this.runVideoProbe(provider, input);
    }
    const started = Date.now();
    try {
      const result = await provider.chatNonStream(
        { baseUrl: input.baseUrl } as Channel,
        input.apiKey,
        {
          model: input.model,
          // 最小化请求体，最大化兼容性（max_tokens 等由各协议适配器按需补默认值）
          body: {
            model: input.model,
            messages: [{ role: 'user', content: 'ping' }],
          },
          timeoutMs: 20000,
        },
      );
      const latencyMs = Date.now() - started;
      const sample = result.json?.choices?.[0]?.message?.content;
      return {
        ok: true,
        status: result.status,
        latencyMs,
        model: input.model,
        provider: input.provider,
        sample: typeof sample === 'string' ? sample.slice(0, 200) : '',
      };
    } catch (e) {
      const latencyMs = Date.now() - started;
      const base = {
        ok: false,
        latencyMs,
        model: input.model,
        provider: input.provider,
      };
      if (e instanceof UpstreamError) {
        return {
          ...base,
          status: e.status,
          error: extractUpstreamError(e.body, e.message),
          detail: redactDetail(safeStringify(e.body)),
        };
      }
      return {
        ...base,
        status: 0,
        error: redactSecrets((e as Error)?.message ?? 'unknown error'),
        detail: null,
      };
    }
  }

  /** 模型能力（目录行）；目录缺失/查询失败一律降级 [] → 保持原聊天探针行为 */
  private async modelCapabilities(model: string): Promise<string[]> {
    try {
      const row = await this.prisma.modelCatalog.findFirst({
        where: { OR: [{ name: model }, { aliases: { has: model } }] },
        select: { capabilities: true },
      });
      return row?.capabilities ?? [];
    } catch {
      return [];
    }
  }

  /**
   * 视频模型连通性探测：GET /videos/{随机假任务ID}（只读，不触发生成）。
   * - 4xx 且错误体带 task 语义（任务不存在）→ 端点与鉴权可达 = 通过
   * - 连接失败 / 5xx / 鉴权失败 / 端点缺失（无 task 语义）→ 失败并透出上游错误
   */
  private async runVideoProbe(
    provider: Provider,
    input: UpstreamProbeInput,
  ): Promise<UpstreamProbeResult> {
    const started = Date.now();
    try {
      const result = await provider.videoStatus!(
        { baseUrl: input.baseUrl } as Channel,
        input.apiKey,
        { taskId: `conn_probe_${Date.now()}`, timeoutMs: 20000 },
      );
      return {
        ok: true,
        status: result.status,
        latencyMs: Date.now() - started,
        model: input.model,
        provider: input.provider,
        sample: 'video route reachable',
      };
    } catch (e) {
      const latencyMs = Date.now() - started;
      const base = { model: input.model, provider: input.provider };
      if (e instanceof UpstreamError) {
        const text = `${e.message} ${safeStringify(e.body) ?? ''}`;
        const taskScope =
          (e.status === 400 || e.status === 404 || e.status === 410 || e.status === 422) &&
          /task/i.test(text);
        if (taskScope) {
          return {
            ok: true,
            status: e.status,
            latencyMs,
            ...base,
            sample: 'video route reachable (unknown task)',
          };
        }
        return {
          ...base,
          ok: false,
          status: e.status,
          latencyMs,
          error: extractUpstreamError(e.body, e.message),
          detail: redactDetail(safeStringify(e.body)),
        };
      }
      return {
        ...base,
        ok: false,
        status: 0,
        latencyMs,
        error: redactSecrets((e as Error)?.message ?? 'unknown error'),
        detail: null,
      };
    }
  }
}
