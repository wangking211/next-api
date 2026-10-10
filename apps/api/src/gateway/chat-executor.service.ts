/**
 * 对话能力执行器：/v1/chat/completions 的 OpenAI 内部形态执行（含流式 SSE pipeStream、
 * token 估算 estimateUsage、预授权与故障转移）；Anthropic Messages 路由复用同一执行器。
 */
import { Injectable } from '@nestjs/common';
import type { Response } from 'express';
import { Channel } from '@prisma/client';
import { ConfigService } from '@nestjs/config';
import { trackClientClose } from './client-close';
import { BillingService } from '../billing/billing.service';
import type { ChannelPricing } from '../billing/pricing.util';
import { UsageService } from '../usage/usage.service';
import type { UsageEntry } from '../usage/usage.service';
import { SseUsageCollector } from '../usage/sse-usage.collector';
import { estimatePromptTokens, estimateTokensFromText } from '../usage/token.util';
import { flattenMessages, extractAssistantText } from '../usage/content.util';
import { ChannelHealthService } from './channel-health.service';
import { RoutingMetricsService } from './routing-metrics.service';
import { ProviderRegistry } from './providers/provider.registry';
import { classifyUpstreamFailure, upstreamErrorMessage } from './upstream-error.util';
import { ChannelResolverService } from './channel-resolver.service';
import { GroupsService } from '../groups/groups.service';
import { ExecSupportService } from './exec-support.service';
import { settleInBackground } from './settle.util';
import { UpstreamError, openaiError } from './types';
import type { GatewayAuthContext, GatewayRequest, StreamResult } from './types';
import {
  AnthropicStreamTranslator,
  openAiToAnthropicResponse,
  toAnthropicErrorBody,
} from './anthropic-format';

@Injectable()
export class ChatExecutorService {
  private readonly streamIdleMs: number;
  private readonly defaultMaxOutputTokens: number;
  /** 内容日志开关（与 UsageService 同口径）：false 时跳过拍平/抽取，省 CPU（生产 LOG_CONTENT=false） */
  private readonly logContent: boolean;

  constructor(
    private readonly resolver: ChannelResolverService,
    private readonly providers: ProviderRegistry,
    private readonly usage: UsageService,
    private readonly billing: BillingService,
    private readonly health: ChannelHealthService,
    private readonly metrics: RoutingMetricsService,
    private readonly groups: GroupsService,
    private readonly support: ExecSupportService,
    config: ConfigService,
  ) {
    this.streamIdleMs = Number(config.get<string>('STREAM_IDLE_TIMEOUT_MS', '120000')) || 120000;
    this.defaultMaxOutputTokens =
      Number(config.get<string>('PREAUTH_MAX_OUTPUT_TOKENS', '4096')) || 4096;
    this.logContent = config.get<string>('LOG_CONTENT', 'false') !== 'false';
  }

  async executeChat(
    req: GatewayRequest,
    res: Response,
    body: Record<string, any>,
    apiFormat: 'openai' | 'anthropic',
  ) {
    /** 按客户端协议返回错误体 */
    const err = (message: string, type = 'invalid_request_error', code: string | null = null) =>
      apiFormat === 'anthropic'
        ? toAnthropicErrorBody(message, type)
        : openaiError(message, type, code);
    const { user, apiKey } = req.gateway;
    const requested: string | undefined = body?.model;
    if (!requested) {
      return res.status(400).json(err('Missing required field: model'));
    }
    // 别名解析（含 :latest）与生效分组（令牌 > 用户 > 默认）互不依赖 → 并行
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

    const isStream = body.stream === true;
    const startedAt = Date.now();
    const promptFallback = estimatePromptTokens(body);
    // LOG_CONTENT=false 时不拍平请求体（生产默认关；落库侧同样会丢弃，纯属省 CPU）
    const requestPreview = this.logContent ? flattenMessages(body) : '';
    let lastError: UpstreamError | null = null;

    // 平台渠道需余额：0 价模型豁免；对每个候选渠道按“输入 + 最大输出”预估上限做预授权，避免单次调用透支
    const guards = this.support.balanceGuards(user.id, billingInfo.value);
    const maxOutputTokens =
      Number(body?.max_tokens ?? body?.max_completion_tokens ?? 0) || this.defaultMaxOutputTokens;
    let insufficientBalance = false;

    // 客户端断开时中止上游请求，避免连接泄漏（closeTracker 仅在提前断开时置位，正常完成的 close 不算）
    const upstreamAbort = new AbortController();
    const closeTracker = trackClientClose(res, () => upstreamAbort.abort());

    for (let i = 0; i < channels.length; i++) {
      // 整请求 deadline：跨故障转移共享总预算，耗尽即 504（流头已发出的长流不受此限）
      if (this.support.deadlineLeft(startedAt) <= 0) {
        return this.support.respondDeadline(res, err);
      }
      const { channel, apiKey: upstreamKey, upstreamModelName, pricing } = channels[i];
      // 模型映射：对外规范名 → 上游真实名（渠道×模型未配置则用规范名）
      const upstreamModel = upstreamModelName ?? model;
      const upstreamBody = upstreamModel === model ? body : { ...body, model: upstreamModel };
      if (this.support.isChargeable(channel, user.id)) {
        // 预授权：按该渠道的售价预估上限，余额不足则跳过（定价随 resolve 结果带出，免再查）
        const required =
          ((promptFallback / 1_000_000) * pricing.priceInput +
            (maxOutputTokens / 1_000_000) * pricing.priceOutput) *
          (await guards.getUserMultiplier());
        if (required > 0 && (await guards.getBalance()) < required) {
          insufficientBalance = true;
          continue;
        }
      }
      const provider = this.providers.resolve(channel.provider);
      const attemptStart = Date.now();
      try {
        if (isStream) {
          const result = await provider.chatStream(channel, upstreamKey, {
            model: upstreamModel,
            body: upstreamBody,
            signal: upstreamAbort.signal,
            timeoutMs: 0, // 流式不设总超时，改由空闲超时 + 客户端断开控制
          });
          return await this.pipeStream(res, result, {
            userId: user.id,
            apiKeyId: apiKey.id,
            channel,
            model,
            startedAt,
            attemptStart,
            promptFallback,
            requestPreview,
            chargeable: this.support.isChargeable(channel, user.id),
            share: this.support.shareContext(channel, user.id),
            abort: upstreamAbort,
            idleMs: this.streamIdleMs,
            isClientClosed: () => closeTracker.isClosed(),
            apiFormat,
            multiplier: billingInfo.value,
            multiplierSource: billingInfo.source,
            pricing,
            tpm: req.gateway.tpm,
          });
        }

        const result = await provider.chatNonStream(channel, upstreamKey, {
          model: upstreamModel,
          body: upstreamBody,
          signal: upstreamAbort.signal,
          // 单次尝试超时：默认 120s，但不超过整请求剩余预算（留给后续候选转移的时间）
          timeoutMs: this.support.attemptTimeoutMs(startedAt),
        });
        const usage = result.usage ?? this.estimateUsage(body, result.json);
        // TPM 回填：结算在 guard 的 finish 监听里按 实际−预估 校正
        if (req.gateway.tpm) req.gateway.tpm.actual = usage.totalTokens;
        // 先把响应写出去：客户端不必等 DB 事务 + Redis 写完
        const payload =
          apiFormat === 'anthropic' ? openAiToAnthropicResponse(result.json, model) : result.json;
        const response = res.status(result.status).json(payload);
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
            responsePreview: this.logContent ? extractAssistantText(result.json) : null,
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
        return response;
      } catch (e) {
        // 客户端已断开：中止是本端触发的，不计渠道失败、不再故障转移
        //（全部候选共享同一 signal，继续试只会连败触发冷却/自动禁用）
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
            isStream,
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

    return res
      .status(lastError?.status ?? 502)
      .json(
        err(lastError ? upstreamErrorMessage(lastError) : 'All channels failed', 'upstream_error'),
      );
  }

  private estimateUsage(body: Record<string, any>, json: any) {
    const promptTokens = estimatePromptTokens(body);
    const text = json?.choices?.[0]?.message?.content;
    const completionTokens = typeof text === 'string' ? estimateTokensFromText(text) : 0;
    return {
      promptTokens,
      completionTokens,
      totalTokens: promptTokens + completionTokens,
    };
  }

  private async pipeStream(
    res: Response,
    result: StreamResult,
    meta: {
      userId: string;
      apiKeyId: string;
      channel: Channel;
      model: string;
      startedAt: number;
      /** 本次候选尝试的开始时刻（路由延迟指标用，不含此前候选的耗时） */
      attemptStart: number;
      promptFallback: number;
      requestPreview: string;
      chargeable: boolean;
      abort?: AbortController;
      idleMs?: number;
      isClientClosed?: () => boolean;
      apiFormat?: 'openai' | 'anthropic';
      /** 本次生效的售价倍率与来源（账单审计） */
      multiplier?: number;
      multiplierSource?: string;
      /** 渠道×模型定价（随 resolve 带出）：落账免再查 */
      pricing?: ChannelPricing;
      /** 共享分成上下文（他人上架的渠道）：落账时给渠道主入账 */
      share?: UsageEntry['share'];
      /** TPM 预扣上下文（guard 注入；流结束后回填实际用量） */
      tpm?: GatewayAuthContext['tpm'];
    },
  ): Promise<void> {
    res.setHeader('Content-Type', 'text/event-stream; charset=utf-8');
    res.setHeader('Cache-Control', 'no-cache, no-transform');
    res.setHeader('Connection', 'keep-alive');
    res.setHeader('X-Accel-Buffering', 'no');
    if (result.headers) {
      for (const [k, v] of Object.entries(result.headers)) res.setHeader(k, v);
    }
    res.flushHeaders?.();

    const collector = new SseUsageCollector();
    // Anthropic 客户端：用量仍从原始 OpenAI 分片收集，但写出的内容翻译为 Anthropic 流事件
    const translator =
      meta.apiFormat === 'anthropic'
        ? new AnthropicStreamTranslator(meta.model, meta.promptFallback)
        : null;
    if (translator) {
      for (const ev of translator.begin()) res.write(ev);
    }
    let errorMessage: string | null = null;
    let streamError: unknown = null;
    let idleTimer: NodeJS.Timeout | null = null;
    const idleMs = meta.idleMs ?? 0;
    const clearIdle = () => {
      if (idleTimer) {
        clearTimeout(idleTimer);
        idleTimer = null;
      }
    };
    // 空闲超时：超过 idleMs 没有新分片则中止上游（而非限制整个流的时长）
    const armIdle = () => {
      if (idleMs > 0 && meta.abort) {
        clearIdle();
        idleTimer = setTimeout(() => meta.abort?.abort(), idleMs);
      }
    };

    try {
      armIdle();
      for await (const chunk of result.chunks) {
        armIdle();
        collector.push(chunk);
        if (translator) {
          for (const ev of translator.push(chunk)) res.write(ev);
        } else {
          res.write(chunk);
        }
      }
    } catch (e: any) {
      streamError = e;
      errorMessage = e?.message ?? 'stream interrupted';
    } finally {
      clearIdle();
      if (translator) {
        for (const ev of translator.flush(
          meta.isClientClosed?.() ? undefined : (errorMessage ?? undefined),
        ))
          res.write(ev);
      }
    }

    // 实时读取客户端状态：循环前的快照会漏掉「流中断开」，导致客户端断开被误报为 500/计渠道失败
    const clientClosed = meta.isClientClosed?.() ?? false;
    const status = clientClosed ? 499 : errorMessage ? 500 : 200;
    // 优先使用 provider 在流式翻译中采集到的真实用量（如 Anthropic 不产出 usage 分片），
    // 缺失时才回退到 SSE 收集器（解析 usage 分片或按输出长度估算）。
    const usage = result.usageRef?.usage ?? collector.result(meta.promptFallback);
    // TPM 回填（结算由 guard 的 finish 监听触发）
    if (meta.tpm) meta.tpm.actual = usage.totalTokens;
    // 计费/健康度/路由指标互不依赖 → 并行落地，缩短响应路径串行耗时
    const tasks: Promise<unknown>[] = [
      this.usage.record({
        userId: meta.userId,
        apiKeyId: meta.apiKeyId,
        channelId: meta.channel.id,
        model: meta.model,
        provider: meta.channel.provider,
        ...usage,
        latencyMs: Date.now() - meta.startedAt,
        status,
        errorMessage: clientClosed ? 'client closed connection' : errorMessage,
        chargeable: meta.chargeable,
        isStream: true,
        requestPreview: meta.requestPreview,
        responsePreview: collector.text,
        multiplier: meta.multiplier,
        multiplierSource: meta.multiplierSource,
        pricing: meta.pricing,
        share: meta.share,
      }),
    ];

    // 客户端主动断开不计入渠道健康度
    if (!clientClosed) {
      const latencyMs = Date.now() - meta.attemptStart;
      if (streamError) {
        // 响应头已发出、无法故障转移，但健康度/路由指标口径与故障转移路径一致：
        // 中途 429 → rate_limited 不计失败；拒答 → refused 只降质量分；其余计失败（含模型级豁免）
        tasks.push(
          this.support.recordOutcomes(
            meta.channel,
            meta.model,
            classifyUpstreamFailure(streamError),
            {
              latencyMs,
              errorMessage: errorMessage ?? 'stream interrupted',
              totalTokens: usage.totalTokens,
            },
          ),
        );
      } else {
        tasks.push(
          this.health.recordSuccess(meta.channel.id, meta.channel.failureCount),
          this.metrics.record(meta.channel.id, meta.model, 'ok', {
            latencyMs,
            status: 200,
            completionTokens: usage.completionTokens,
            totalTokens: usage.totalTokens,
          }),
        );
      }
    }
    // 客户端已收完整个流：先结束响应，落账/健康度/指标转后台结算，不拖长连接占用
    if (!res.writableEnded) res.end();
    settleInBackground(tasks);
  }
}
