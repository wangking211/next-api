/** 图片生成能力执行器：/v1/images/generations（按次计费，未配置按次价则回退 token 计价）。 */
import { Injectable } from '@nestjs/common';
import type { Response } from 'express';
import { trackClientClose } from './client-close';
import { BillingService } from '../billing/billing.service';
import { GroupsService } from '../groups/groups.service';
import { UsageService } from '../usage/usage.service';
import { ChannelResolverService } from './channel-resolver.service';
import { ChannelHealthService } from './channel-health.service';
import { RoutingMetricsService } from './routing-metrics.service';
import { ProviderRegistry } from './providers/provider.registry';
import { ExecSupportService } from './exec-support.service';
import { settleInBackground } from './settle.util';
import { upstreamErrorMessage } from './upstream-error.util';
import { UpstreamError, openaiError } from './types';
import type { GatewayRequest } from './types';

@Injectable()
export class ImagesExecutorService {
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
   * 图片生成执行：与 embeddings 同构（别名→能力→路由→预授权→故障转移→计费/健康/指标）。
   * 计费：配置了按次价（目录 perCallPrice / 渠道 pricePerCall）则按次计费（×张数 ×倍率）；
   * 否则回退 token 计价（如 gpt-image 系列上游返回 usage）。
   */
  async executeImages(req: GatewayRequest, res: Response, body: Record<string, any>) {
    const err = (message: string, type = 'invalid_request_error', code: string | null = null) =>
      openaiError(message, type, code);
    const { user, apiKey } = req.gateway;
    const requested: string | undefined = body?.model;
    if (!requested) {
      return res.status(400).json(err('Missing required field: model'));
    }
    const prompt = body?.prompt;
    if (typeof prompt !== 'string' || !prompt.trim()) {
      return res.status(400).json(err('Missing required field: prompt (non-empty string)'));
    }
    const n = Math.max(1, Math.min(Math.floor(Number(body?.n ?? 1) || 1), 10));

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
    const requestPreview = prompt.slice(0, 500);
    let lastError: UpstreamError | null = null;
    let unsupported = false; // 有候选但服务商未实现图片生成
    let insufficientBalance = false;
    const guards = this.support.balanceGuards(user.id, billingInfo.value);

    // 客户端断开时中止上游请求，避免连接泄漏（closeTracker 仅在提前断开时置位）
    const upstreamAbort = new AbortController();
    const closeTracker = trackClientClose(res, () => upstreamAbort.abort());

    for (let i = 0; i < channels.length; i++) {
      // 整请求 deadline：跨故障转移共享总预算，耗尽即 504
      if (this.support.deadlineLeft(startedAt) <= 0) {
        return this.support.respondDeadline(res, err);
      }
      const { channel, apiKey: upstreamKey, upstreamModelName, pricing } = channels[i];
      // 模型映射：对外规范名 → 上游真实名。
      // n 必须用截断后的值写回：否则客户端传 n=100 时预授权/落账按 10 张算、
      // 上游却按 100 张出图（收入漏损）
      const upstreamModel = upstreamModelName ?? model;
      const upstreamBody = { ...body, model: upstreamModel, n };
      const provider = this.providers.resolve(channel.provider);
      if (typeof provider.imagesGenerate !== 'function') {
        unsupported = true;
        continue;
      }
      const pricePerCall = pricing.pricePerCall;
      const costPerCall = pricing.costPerCall;
      // 预授权：按次价 × 张数 × 倍率（未配置按次价时不做按次预授权）
      if (this.support.isChargeable(channel, user.id) && pricePerCall > 0) {
        const required = pricePerCall * n * billingInfo.value;
        if ((await guards.getBalance()) < required) {
          insufficientBalance = true;
          continue;
        }
      }
      const attemptStart = Date.now();
      try {
        const result = await provider.imagesGenerate(channel, upstreamKey, {
          model: upstreamModel,
          body: upstreamBody,
          signal: upstreamAbort.signal,
          // 单次尝试超时：默认 120s，且不超过整请求剩余预算
          timeoutMs: this.support.attemptTimeoutMs(startedAt),
        });
        const perCall = pricePerCall > 0;
        const usage = result.usage ?? {
          promptTokens: 0,
          completionTokens: 0,
          totalTokens: 0,
        };
        // 上游少给按实际张数计费、多给不超预授权（clamp 上限 n）
        const actual = Array.isArray(result.json?.data) ? result.json.data.length : n;
        const images = Math.min(actual, n);
        // 先把响应写出去：客户端不必等 DB 事务 + Redis 写完
        const response = res.status(result.status).json(result.json);
        // 计费/健康度/路由指标互不依赖 → 响应写出后并行后台结算
        settleInBackground([
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
            responsePreview: `[images ${images}]`,
            multiplier: billingInfo.value,
            multiplierSource: billingInfo.source,
            pricing,
            ...(perCall
              ? {
                  costOverride: pricePerCall * images * billingInfo.value,
                  upstreamCostOverride: costPerCall * images,
                }
              : {}),
          }),
          this.health.recordSuccess(channel.id, channel.failureCount),
          this.metrics.record(channel.id, model, 'ok', {
            latencyMs: Date.now() - attemptStart,
            status: result.status,
            totalTokens: usage.totalTokens,
          }),
        ]);
        return response;
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
            `Model "${model}": no upstream with image generation support among available channels ` +
              '(/v1/images/generations is forwarded to openai-compatible providers only).',
            'invalid_request_error',
            'images_not_supported',
          ),
        );
    }
    return res
      .status(lastError?.status ?? 502)
      .json(
        err(lastError ? upstreamErrorMessage(lastError) : 'All channels failed', 'upstream_error'),
      );
  }
}
