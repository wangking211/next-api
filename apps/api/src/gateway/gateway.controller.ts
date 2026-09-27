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

@UseGuards(ApiKeyGuard)
@Controller('v1')
export class GatewayController {
  private readonly streamIdleMs: number;

  constructor(
    private readonly resolver: ChannelResolverService,
    private readonly providers: ProviderRegistry,
    private readonly usage: UsageService,
    private readonly billing: BillingService,
    private readonly health: ChannelHealthService,
    config: ConfigService,
  ) {
    this.streamIdleMs =
      Number(config.get<string>('STREAM_IDLE_TIMEOUT_MS', '120000')) || 120000;
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

    const channels = await this.resolver.resolve(user.id, model);
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

    // 平台渠道需余额：0 价模型豁免；对每个候选渠道逐一判断，避免 BYOK→平台故障转移绕过校验
    let cachedBalance: number | null = null;
    const getBalance = async () => {
      if (cachedBalance === null) {
        cachedBalance = (await this.billing.getBalance(user.id)).balance;
      }
      return cachedBalance;
    };
    let modelFree: boolean | null = null;
    const isModelFree = async () => {
      if (modelFree === null) modelFree = await this.billing.isModelFree(model);
      return modelFree;
    };
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
      if (channel.ownerType === ChannelOwnerType.PLATFORM && !(await isModelFree())) {
        if ((await getBalance()) <= 0) {
          insufficientBalance = true;
          continue;
        }
      }
      const provider = this.providers.resolve(channel.provider);
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
        return res.status(result.status).json(result.json);
      } catch (e) {
        if (e instanceof UpstreamError) {
          lastError = e;
          // 仅将上游/网络类故障（5xx/429/连接失败）计入渠道健康度；客户端 4xx 不计数，防止被恶意请求自动禁用渠道
          if (e.retryable) {
            await this.health.recordFailure(channel.id, e.message);
          }
          const hasMore = i < channels.length - 1;
          if (e.retryable && hasMore) continue; // 故障转移
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
      if (errorMessage) {
        await this.health.recordFailure(meta.channel.id, errorMessage);
      } else {
        await this.health.recordSuccess(meta.channel.id);
      }
    }

    if (!res.writableEnded) res.end();
  }
}
