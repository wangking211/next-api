/**
 * embeddings 能力执行器：/v1/embeddings（向量化透传，按输入 token 计费，无输出 token）。
 * 预览只记首条输入片段与「条数×维度」，向量本身绝不入库（1536 维会撑爆日志）。
 */
import { Injectable } from '@nestjs/common';
import type { Response } from 'express';
import { trackClientClose } from './client-close';
import { BillingService } from '../billing/billing.service';
import { GroupsService } from '../groups/groups.service';
import { UsageService } from '../usage/usage.service';
import { estimatePromptTokens } from '../usage/token.util';
import { ChannelResolverService } from './channel-resolver.service';
import { ChannelHealthService } from './channel-health.service';
import { RoutingMetricsService } from './routing-metrics.service';
import { ProviderRegistry } from './providers/provider.registry';
import { ExecSupportService } from './exec-support.service';
import { upstreamErrorMessage } from './upstream-error.util';
import { UpstreamError, openaiError } from './types';
import type { GatewayRequest } from './types';

/** embeddings 请求预览：只取首个输入片段（批量输入全量写日志会撑爆 RequestLog） */
function embeddingsPreview(body: any): string {
  const input = body?.input;
  if (typeof input === 'string') return input.slice(0, 500);
  if (Array.isArray(input) && input.length > 0) {
    const first =
      typeof input[0] === 'string'
        ? input[0]
        : JSON.stringify(input[0]) ?? '';
    const more = input.length > 1 ? `（+${input.length - 1} 条）` : '';
    return `${first.slice(0, 500)}${more}`;
  }
  return '';
}

/** embeddings 响应预览：只记向量条数与维度，向量本身绝不入库（1536 维会撑爆日志） */
function embeddingsResponsePreview(json: any): string {
  const data = json?.data;
  if (!Array.isArray(data)) return '';
  const dim = Array.isArray(data[0]?.embedding) ? `×${data[0].embedding.length}` : '';
  return `[embeddings ${data.length} ${dim}]`.trim();
}

@Injectable()
export class EmbeddingsExecutorService {
  constructor(
    private readonly resolver: ChannelResolverService,
    private readonly providers: ProviderRegistry,
    private readonly usage: UsageService,
    private readonly billing: BillingService,
    private readonly health: ChannelHealthService,
    private readonly metrics: RoutingMetricsService,
    private readonly groups: GroupsService,
    private readonly support: ExecSupportService,
  ) {}

  /**
   * embeddings 执行：与 executeChat 同构（别名→能力→路由→预授权→故障转移→计费/健康/指标），
   * 差异：只走非流式单跳；input 为 string / string[] / token id 数组；无输出 token；
   * 只有实现了 embeddingsNonStream 的服务商（当前为 OpenAI 兼容类）参与候选。
   */
  async executeEmbeddings(
    req: GatewayRequest,
    res: Response,
    body: Record<string, any>,
  ) {
    const err = (
      message: string,
      type = 'invalid_request_error',
      code: string | null = null,
    ) => openaiError(message, type, code);
    const { user, apiKey } = req.gateway;
    const requested: string | undefined = body?.model;
    if (!requested) {
      return res.status(400).json(err('Missing required field: model'));
    }
    const input = body?.input;
    const hasInput =
      (typeof input === 'string' && input.length > 0) ||
      (Array.isArray(input) && input.length > 0);
    if (!hasInput) {
      return res
        .status(400)
        .json(err('Missing required field: input (non-empty string or array of strings/tokens)'));
    }

    // 别名解析与生效分组互不依赖 → 并行（可见性 / 倍率 / 路由都依赖这两者）
    const [model, group] = await Promise.all([
      this.resolver.resolveAlias(requested),
      this.groups.effectiveGroup(user, apiKey.groupId),
    ]);
    if (!this.groups.isModelVisible(group, model)) {
      return res
        .status(404)
        .json(
          err(
            `No available channel for model "${model}". Configure a channel that serves this model.`,
            'model_not_found',
            'model_not_found',
          ),
        );
    }
    // 倍率 / 能力校验 / 路由互不依赖 → 并行执行（三者都只读，失败语义与串行一致）
    const [billingInfo, channels, capsOk] = await Promise.all([
      this.billing.getBillingMultiplier(user.id, group.ratio, user),
      this.resolver.resolve(user.id, model, {
        strategy: apiKey.routingStrategy,
        stickyKey: this.support.buildStickyKey(req, user.id, body),
        groupId: group.id,
      }),
      this.support.checkCapabilities(model, body, res, err),
    ]);
    if (!capsOk) return;
    if (channels.length === 0) {
      return res
        .status(404)
        .json(
          err(
            `No available channel for model "${model}". Configure a channel that serves this model.`,
            'model_not_found',
            'model_not_found',
          ),
        );
    }

    const startedAt = Date.now();
    const promptFallback = estimatePromptTokens(body);
    const requestPreview = embeddingsPreview(body);
    let lastError: UpstreamError | null = null;
    let unsupported = false; // 存在候选渠道，但其服务商未实现 embeddings 透传
    let insufficientBalance = false;
    const guards = this.support.balanceGuards(user.id, billingInfo.value);

    // 客户端断开时中止上游请求，避免连接泄漏（closeTracker 仅在提前断开时置位）
    const upstreamAbort = new AbortController();
    const closeTracker = trackClientClose(res, () => upstreamAbort.abort());

    for (let i = 0; i < channels.length; i++) {
      const { channel, apiKey: upstreamKey, upstreamModelName, pricing } = channels[i];
      // 模型映射：对外规范名 → 上游真实名
      const upstreamModel = upstreamModelName ?? model;
      const upstreamBody =
        upstreamModel === model ? body : { ...body, model: upstreamModel };
      const provider = this.providers.resolve(channel.provider);
      if (typeof provider.embeddingsNonStream !== 'function') {
        unsupported = true; // 如 anthropic/gemini 暂无兼容端点 → 换下一家
        continue;
      }
      if (this.support.isChargeable(channel, user.id)) {
        // 预授权：embeddings 只有输入 token（输出恒为 0），按输入预估上限（定价随 resolve 带出）
        const required =
          (promptFallback / 1_000_000) * pricing.priceInput * (await guards.getUserMultiplier());
        if (required > 0 && (await guards.getBalance()) < required) {
          insufficientBalance = true;
          continue;
        }
      }
      const attemptStart = Date.now();
      try {
        const result = await provider.embeddingsNonStream(channel, upstreamKey, {
          model: upstreamModel,
          body: upstreamBody,
          signal: upstreamAbort.signal,
          // timeoutMs 未传 → 默认 120s 上游总超时
        });
        // 上游未回 usage 时按 input 兜底估算；embeddings 无输出 token
        const usage = result.usage ?? {
          promptTokens: promptFallback,
          completionTokens: 0,
          totalTokens: promptFallback,
        };
        // TPM 回填：结算在 guard 的 finish 监听里按 实际−预估 校正
        if (req.gateway.tpm) req.gateway.tpm.actual = usage.totalTokens;
        // 计费/健康度/路由指标互不依赖 → 并行落地，缩短响应路径串行耗时
        await Promise.all([
          this.usage.record({
            userId: user.id,
            apiKeyId: apiKey.id,
            channelId: channel.id,
            model,
            provider: channel.provider,
            ...usage,
            latencyMs: Date.now() - startedAt,
            status: result.status,
            chargeable: this.support.isChargeable(channel, user.id),
            share: this.support.shareContext(channel, user.id),
            isStream: false,
            requestPreview,
            responsePreview: embeddingsResponsePreview(result.json),
            multiplier: billingInfo.value,
            multiplierSource: billingInfo.source,
            pricing,
          }),
          this.health.recordSuccess(channel.id, channel.failureCount),
          this.metrics.record(channel.id, model, 'ok', {
            latencyMs: Date.now() - attemptStart,
            completionTokens: usage.completionTokens,
            totalTokens: usage.totalTokens,
            status: result.status,
          }),
        ]);
        return res.status(result.status).json(result.json);
      } catch (e) {
        // 客户端已断开：中止是本端触发的，不计渠道失败、不再故障转移
        if (closeTracker.isClosed()) return;
        if (e instanceof UpstreamError) {
          lastError = e;
          const action = await this.support.handleUpstreamFailure(e, {
            res,
            channel,
            model,
            attemptStart,
            startedAt,
            userId: user.id,
            apiKeyId: apiKey.id,
            requestPreview,
            isStream: false,
            hasMore: i < channels.length - 1,
            pricing,
            multiplier: billingInfo.value,
            multiplierSource: billingInfo.source,
            errorBody: err,
          });
          if (action === 'continue') continue;
          return;
        }
        throw e;
      }
    }

    if (insufficientBalance) {
      return res
        .status(403)
        .json(
          err(
            'Insufficient balance. Please top up or configure a BYOK channel.',
            'insufficient_quota',
            'insufficient_balance',
          ),
        );
    }
    if (unsupported && !lastError) {
      return res
        .status(501)
        .json(
          err(
            `Model "${model}": no upstream with embeddings support among available channels ` +
              '(/v1/embeddings is forwarded to openai-compatible providers only).',
            'invalid_request_error',
            'embeddings_not_supported',
          ),
        );
    }
    return res
      .status(lastError?.status ?? 502)
      .json(
        err(
          lastError ? upstreamErrorMessage(lastError) : 'All channels failed',
          'upstream_error',
        ),
      );
  }

}
