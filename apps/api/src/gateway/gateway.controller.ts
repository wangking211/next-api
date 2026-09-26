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

@UseGuards(ApiKeyGuard)
@Controller('v1')
export class GatewayController {
  constructor(
    private readonly resolver: ChannelResolverService,
    private readonly providers: ProviderRegistry,
    private readonly usage: UsageService,
    private readonly billing: BillingService,
    private readonly health: ChannelHealthService,
  ) {}

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

    // 平台渠道需要余额；若首选渠道为平台渠道且余额不足则拦截（BYOK 不扣费）
    if (channels[0].channel.ownerType === ChannelOwnerType.PLATFORM) {
      const { balance } = await this.billing.getBalance(user.id);
      if (balance <= 0) {
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
    }

    const isStream = body.stream === true;
    const startedAt = Date.now();
    const promptFallback = estimatePromptTokens(body);
    const requestPreview = flattenMessages(body);
    let lastError: UpstreamError | null = null;

    for (let i = 0; i < channels.length; i++) {
      const { channel, apiKey: upstreamKey } = channels[i];
      const provider = this.providers.resolve(channel.provider);
      try {
        if (isStream) {
          const result = await provider.chatStream(channel, upstreamKey, { model, body });
          return await this.pipeStream(res, result, {
            userId: user.id,
            apiKeyId: apiKey.id,
            channel,
            model,
            startedAt,
            promptFallback,
            requestPreview,
            chargeable: channel.ownerType === ChannelOwnerType.PLATFORM,
          });
        }

        const result = await provider.chatNonStream(channel, upstreamKey, { model, body });
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
          await this.health.recordFailure(channel.id, e.message);
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
            .json(e.body ?? openaiError(e.message, 'upstream_error'));
        }
        throw e;
      }
    }

    return res
      .status(lastError?.status ?? 502)
      .json(
        lastError?.body ??
          openaiError(lastError?.message ?? 'All channels failed', 'upstream_error'),
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
    try {
      for await (const chunk of result.chunks) {
        collector.push(chunk);
        res.write(chunk);
      }
    } catch (e: any) {
      errorMessage = e?.message ?? 'stream interrupted';
    }

    const usage = collector.result(meta.promptFallback);
    await this.usage.record({
      userId: meta.userId,
      apiKeyId: meta.apiKeyId,
      channelId: meta.channel.id,
      model: meta.model,
      provider: meta.channel.provider,
      ...usage,
      latencyMs: Date.now() - meta.startedAt,
      status: errorMessage ? 500 : 200,
      errorMessage,
      chargeable: meta.chargeable,
      isStream: true,
      requestPreview: meta.requestPreview,
      responsePreview: collector.text,
    });

    if (errorMessage) {
      await this.health.recordFailure(meta.channel.id, errorMessage);
    } else {
      await this.health.recordSuccess(meta.channel.id);
    }

    if (!res.writableEnded) res.end();
  }
}
