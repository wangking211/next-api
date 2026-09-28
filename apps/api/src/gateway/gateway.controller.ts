import {
  Body,
  Controller,
  Get,
  HttpCode,
  Post,
  Req,
  Res,
  UseGuards,
} from '@nestjs/common';
import { Response } from 'express';
import { ConfigService } from '@nestjs/config';
import { ApiKeyGuard } from './guards/api-key.guard';
import { ChannelResolverService } from './channel-resolver.service';
import { ProviderRegistry } from './providers/provider.registry';
import { ChannelHealthService } from './channel-health.service';
import { RoutingMetricsService } from './routing-metrics.service';
import { GatewayRequest, UpstreamError, openaiError } from './types';
import { UsageService } from '../usage/usage.service';
import { BillingService } from '../billing/billing.service';
import { SseUsageCollector } from '../usage/sse-usage.collector';
import { estimatePromptTokens, estimateTokensFromText } from '../usage/token.util';
import { flattenMessages, extractAssistantText } from '../usage/content.util';
import { Channel, ChannelOwnerType } from '@prisma/client';

/** 仅提取上游错误消息，避免把上游原始错误体（可能含内部细节）原样透传给客户端 */
function upstreamErrorMessage(e: UpstreamError): string {
  const body = e.body;
  const msg =
    (typeof body?.error?.message === 'string' && body.error.message) ||
    (typeof body?.message === 'string' && body.message) ||
    e.message;
  return String(msg).slice(0, 500);
}

/** 上游错误的可判定文本：message + code + type（UpstreamError.message 只有 "Upstream error 429"，语义在 body 里） */
function upstreamErrorSignal(e: UpstreamError): string {
  const body = e.body;
  const parts = [
    typeof body?.error?.message === 'string' ? body.error.message : '',
    typeof body?.error?.code === 'string' ? body.error.code : '',
    typeof body?.error?.type === 'string' ? body.error.type : '',
    typeof body?.message === 'string' ? body.message : '',
  ];
  return parts.filter(Boolean).join(' ');
}

/** 配额/限流特征：429，或 4xx 错误文本命中限额语义（订阅号日限额常见 400/403 + quota 文案） */
const QUOTA_RE =
  /(insufficient[_\s-]?quota|rate[_\s-]?limit|too many requests|quota|usage.{0,15}(limit|exceed)|daily.{0,15}(limit|quota)|limit.{0,20}(exceed|exhaust|reach|hit)|exceeded.{0,15}(limit|quota)|请求过于频繁|超出.{0,8}(限额|限制|配额)|限流|配额)/i;

function isRateLimited(e: UpstreamError): boolean {
  if (e.status === 429) return true;
  if (e.status < 400 || e.status >= 500) return false;
  return QUOTA_RE.test(upstreamErrorSignal(e));
}

/** 拒答/内容过滤特征：用户内容被安全策略拒绝，只降质量分，不伤稳定性也不熔断 */
const REFUSAL_RE =
  /(content[_\s-]?filter|content_policy|safety|refusal|refused|内容安全|敏感内容)/i;

function isRefusal(e: UpstreamError): boolean {
  return REFUSAL_RE.test(upstreamErrorSignal(e));
}

@UseGuards(ApiKeyGuard)
@Controller('v1')
export class GatewayController {
  private readonly streamIdleMs: number;
  private readonly defaultMaxOutputTokens: number;

  constructor(
    private readonly resolver: ChannelResolverService,
    private readonly providers: ProviderRegistry,
    private readonly usage: UsageService,
    private readonly billing: BillingService,
    private readonly health: ChannelHealthService,
    private readonly metrics: RoutingMetricsService,
    config: ConfigService,
  ) {
    this.streamIdleMs =
      Number(config.get<string>('STREAM_IDLE_TIMEOUT_MS', '120000')) || 120000;
    this.defaultMaxOutputTokens =
      Number(config.get<string>('PREAUTH_MAX_OUTPUT_TOKENS', '4096')) || 4096;
  }

  @Get('models')
  async listModels(@Req() req: GatewayRequest, @Res() res: Response) {
    const { user } = req.gateway;
    const models = await this.resolver.availableModels(user.id);
    res.json({
      object: 'list',
      data: models.map((id) => ({
        id,
        object: 'model',
        created: Math.floor(Date.now() / 1000),
        owned_by: 'ai-gateway',
      })),
    });
  }

  @Post('chat/completions')
  @HttpCode(200)
  async chatCompletions(
    @Req() req: GatewayRequest,
    @Res() res: Response,
    @Body() body: Record<string, any>,
  ) {
    const { user, apiKey } = req.gateway;
    const model: string | undefined = body?.model;
    if (!model) {
      return res
        .status(400)
        .json(openaiError('Missing required field: model', 'invalid_request_error'));
    }

    const channels = await this.resolver.resolve(user.id, model, {
      strategy: apiKey.routingStrategy,
      stickyKey: this.buildStickyKey(req, user.id, body),
    });
    if (channels.length === 0) {
      return res
        .status(404)
        .json(
          openaiError(
            `No available channel for model "${model}". Configure a channel that serves this model.`,
            'model_not_found',
            'model_not_found',
          ),
        );
    }

    const isStream = body.stream === true;
    const startedAt = Date.now();
    const promptFallback = estimatePromptTokens(body);
    const requestPreview = flattenMessages(body);
    let lastError: UpstreamError | null = null;

    // 平台渠道需余额：0 价模型豁免；对每个候选渠道按“输入 + 最大输出”预估上限做预授权，避免单次调用透支
    let cachedBalance: number | null = null;
    const getBalance = async () => {
      if (cachedBalance === null) {
        cachedBalance = (await this.billing.getBalance(user.id)).balance;
      }
      return cachedBalance;
    };
    let cachedMultiplier: number | null = null;
    const getUserMultiplier = async () => {
      if (cachedMultiplier === null) {
        cachedMultiplier = await this.billing.getUserMultiplier(user.id);
      }
      return cachedMultiplier;
    };
    const maxOutputTokens =
      Number(body?.max_tokens ?? body?.max_completion_tokens ?? 0) ||
      this.defaultMaxOutputTokens;
    let insufficientBalance = false;

    // 客户端断开时中止上游请求，避免连接泄漏
    const upstreamAbort = new AbortController();
    let clientClosed = false;
    res.on('close', () => {
      clientClosed = true;
      upstreamAbort.abort();
    });

    for (let i = 0; i < channels.length; i++) {
      const { channel, apiKey: upstreamKey } = channels[i];
      if (channel.ownerType === ChannelOwnerType.PLATFORM) {
        // 预授权：按该渠道的售价预估上限，余额不足则跳过
        const p = await this.billing.getChannelPricing(channel.id, model);
        const required =
          ((promptFallback / 1_000_000) * p.priceInput +
            (maxOutputTokens / 1_000_000) * p.priceOutput) *
          (await getUserMultiplier());
        if (required > 0 && (await getBalance()) < required) {
          insufficientBalance = true;
          continue;
        }
      }
      const provider = this.providers.resolve(channel.provider);
      const attemptStart = Date.now();
      try {
        if (isStream) {
          const result = await provider.chatStream(channel, upstreamKey, {
            model,
            body,
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
            chargeable: channel.ownerType === ChannelOwnerType.PLATFORM,
            abort: upstreamAbort,
            idleMs: this.streamIdleMs,
            isClientClosed: () => clientClosed,
          });
        }

        const result = await provider.chatNonStream(channel, upstreamKey, {
          model,
          body,
          signal: upstreamAbort.signal,
        });
        const usage = result.usage ?? this.estimateUsage(body, result.json);
        await this.usage.record({
          userId: user.id,
          apiKeyId: apiKey.id,
          channelId: channel.id,
          model,
          provider: channel.provider,
          ...usage,
          latencyMs: Date.now() - startedAt,
          status: result.status,
          chargeable: channel.ownerType === ChannelOwnerType.PLATFORM,
          isStream: false,
          requestPreview,
          responsePreview: extractAssistantText(result.json),
        });
        await this.health.recordSuccess(channel.id);
        await this.metrics.record(channel.id, model, 'ok', {
          latencyMs: Date.now() - attemptStart,
          completionTokens: usage.completionTokens,
          totalTokens: usage.totalTokens,
          status: result.status,
        });
        return res.status(result.status).json(result.json);
      } catch (e) {
        if (e instanceof UpstreamError) {
          lastError = e;
          const latencyMs = Date.now() - attemptStart;
          const signal = upstreamErrorSignal(e) || e.message;
          // 错误分类（客户端 4xx 不计健康度，防止被恶意请求自动禁用渠道）：
          //  限流/超限 → 冷却退避且不累计失败；5xx/连接故障 → 健康度失败计数；
          //  上游鉴权失败(401) → 只降路由质量分；拒答/内容过滤 → 只降质量分
          const limited = isRateLimited(e);
          const transient = e.retryable && !limited;
          const authFault = !limited && e.status === 401;
          const refusal = !limited && !transient && !authFault && isRefusal(e);
          if (limited) {
            await this.health.recordRateLimited(channel.id, signal);
            await this.metrics.record(channel.id, model, 'rate_limited', {
              latencyMs,
              status: e.status,
              errorMessage: signal,
            });
          } else if (transient) {
            await this.health.recordFailure(channel.id, e.message);
            await this.metrics.record(channel.id, model, 'error', {
              latencyMs,
              status: e.status,
              errorMessage: signal,
            });
          } else if (authFault || refusal) {
            await this.metrics.record(channel.id, model, authFault ? 'error' : 'refused', {
              latencyMs,
              status: e.status,
              errorMessage: signal,
            });
          }
          const hasMore = i < channels.length - 1;
          // 故障转移：上游故障、限流/超限、鉴权失效都要换下一家试
          if ((transient || limited || authFault) && hasMore) continue;
          await this.usage.record({
            userId: user.id,
            apiKeyId: apiKey.id,
            channelId: channel.id,
            model,
            provider: channel.provider,
            promptTokens: 0,
            completionTokens: 0,
            totalTokens: 0,
            latencyMs: Date.now() - startedAt,
            status: e.status || 502,
            errorMessage: e.message,
            chargeable: channel.ownerType === ChannelOwnerType.PLATFORM,
            isStream,
            requestPreview,
          });
          return res
            .status(e.status || 502)
            .json(openaiError(upstreamErrorMessage(e), 'upstream_error'));
        }
        throw e;
      }
    }

    if (insufficientBalance) {
      return res
        .status(403)
        .json(
          openaiError(
            'Insufficient balance. Please top up or configure a BYOK channel.',
            'insufficient_quota',
            'insufficient_balance',
          ),
        );
    }

    return res
      .status(lastError?.status ?? 502)
      .json(
        openaiError(
          lastError ? upstreamErrorMessage(lastError) : 'All channels failed',
          'upstream_error',
        ),
      );
  }

  /**
   * 会话粘性键：显式 x-session-id 优先（前端可传会话 ID），否则用 用户 + prompt 前缀。
   * 同键请求倾向落同一渠道，保住上游 prompt cache；跨会话/跨请求则自然分散。
   */
  private buildStickyKey(
    req: GatewayRequest,
    userId: string,
    body: Record<string, any>,
  ): string {
    const sid = req.headers['x-session-id'];
    if (typeof sid === 'string' && sid.trim()) return sid.trim().slice(0, 128);
    try {
      const msgs = Array.isArray(body?.messages) ? body.messages.slice(0, 2) : [];
      const prefix = msgs.length ? JSON.stringify(msgs).slice(0, 256) : '';
      return `${userId}:${prefix}`;
    } catch {
      return userId;
    }
  }

  private estimateUsage(body: Record<string, any>, json: any) {
    const promptTokens = estimatePromptTokens(body);
    const text = json?.choices?.[0]?.message?.content;
    const completionTokens =
      typeof text === 'string' ? estimateTokensFromText(text) : 0;
    return {
      promptTokens,
      completionTokens,
      totalTokens: promptTokens + completionTokens,
    };
  }

  private async pipeStream(
    res: Response,
    result: { chunks: AsyncIterable<string>; headers?: Record<string, string> },
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
    let errorMessage: string | null = null;
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
        res.write(chunk);
      }
    } catch (e: any) {
      errorMessage = e?.message ?? 'stream interrupted';
    } finally {
      clearIdle();
    }

    const clientClosed = meta.isClientClosed?.() ?? false;
    const status = clientClosed ? 499 : errorMessage ? 500 : 200;
    const usage = collector.result(meta.promptFallback);
    await this.usage.record({
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
    });

    // 客户端主动断开不计入渠道健康度
    if (!clientClosed) {
      const latencyMs = Date.now() - meta.attemptStart;
      if (errorMessage) {
        await this.health.recordFailure(meta.channel.id, errorMessage);
        await this.metrics.record(meta.channel.id, meta.model, 'error', {
          latencyMs,
          status: 500,
          totalTokens: usage.totalTokens,
          errorMessage,
        });
      } else {
        await this.health.recordSuccess(meta.channel.id);
        await this.metrics.record(meta.channel.id, meta.model, 'ok', {
          latencyMs,
          status: 200,
          completionTokens: usage.completionTokens,
          totalTokens: usage.totalTokens,
        });
      }
    }

    if (!res.writableEnded) res.end();
  }
}
