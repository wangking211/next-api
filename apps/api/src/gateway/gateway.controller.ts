import {
  Body,
  Controller,
  Get,
  HttpCode,
  Param,
  Post,
  Req,
  Res,
  UseFilters,
  UseGuards,
} from '@nestjs/common';
import { Response } from 'express';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { ConfigService } from '@nestjs/config';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { ApiKeyGuard } from './guards/api-key.guard';
import { GatewayErrorFilter } from './gateway-error.filter';
import { ExecSupportService } from './exec-support.service';
import { ChannelResolverService } from './channel-resolver.service';
import { ProviderRegistry } from './providers/provider.registry';
import { ChannelHealthService } from './channel-health.service';
import { RoutingMetricsService } from './routing-metrics.service';
import { GatewayAuthContext, GatewayRequest, ResolvedChannel, StreamResult, UpstreamError, openaiError } from './types';
import { upstreamErrorMessage } from './upstream-error.util';
import { trackClientClose } from './client-close';
import {
  AnthropicStreamTranslator,
  anthropicToOpenAiRequest,
  openAiToAnthropicResponse,
  toAnthropicErrorBody,
} from './anthropic-format';
import { UsageService } from '../usage/usage.service';
import type { UsageEntry } from '../usage/usage.service';
import { BillingService } from '../billing/billing.service';
import type { ChannelPricing } from '../billing/pricing.util';
import { GroupsService } from '../groups/groups.service';
import { VideoTaskService } from './video-task.service';
import {
  videoCompatCreateResponse,
  videoCompatRequestBody,
  videoCompatStatusResponse,
} from './video-compat.util';
import { SseUsageCollector } from '../usage/sse-usage.collector';
import { estimatePromptTokens, estimateTokensFromText } from '../usage/token.util';
import { flattenMessages, extractAssistantText } from '../usage/content.util';
import { Channel } from '@prisma/client';

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

/** 视频任务 id 只允许安全字符：防止路径穿越把请求打到上游的其它端点 */
const VIDEO_TASK_ID_RE = /^[A-Za-z0-9._:-]{1,128}$/;

@ApiTags('gateway')
@ApiBearerAuth('bearer')
@UseGuards(ApiKeyGuard)
// 未预期异常/守卫/限流的错误体也要符合客户端协议（OpenAI 形状；/v1/messages 为 Anthropic 形状）
@UseFilters(new GatewayErrorFilter())
@Controller('v1')
export class GatewayController {
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
    private readonly videoTasks: VideoTaskService,
    private readonly support: ExecSupportService,
    config: ConfigService,
  ) {
    this.streamIdleMs =
      Number(config.get<string>('STREAM_IDLE_TIMEOUT_MS', '120000')) || 120000;
    this.defaultMaxOutputTokens =
      Number(config.get<string>('PREAUTH_MAX_OUTPUT_TOKENS', '4096')) || 4096;
    this.logContent = config.get<string>('LOG_CONTENT', 'false') !== 'false';
  }

  @ApiOperation({ summary: '列出当前 Key 可用模型（含 capabilities 与别名）' })
  @Get('models')
  async listModels(@Req() req: GatewayRequest, @Res() res: Response) {
    const { user, apiKey } = req.gateway;
    const group = await this.groups.effectiveGroup(user, apiKey.groupId);
    let names = await this.resolver.availableModels(user.id, group.id);
    // 模型分组可见性（分组未配置可见模型 = 不限制）
    names = names.filter((n) => this.groups.isModelVisible(group, n));
    // Key 模型白名单：仅展示允许的模型（空数组表示不限制）
    const allowed = await this.resolver.allowedModelSet(apiKey.models);
    if (allowed) names = names.filter((n) => allowed.has(n));
    const catalog = await this.resolver.catalogFor(names);
    const created = Math.floor(Date.now() / 1000);
    const seen = new Set<string>();
    const data: Record<string, unknown>[] = [];
    const emit = (id: string, canonical: string | null) => {
      if (seen.has(id)) return;
      seen.add(id);
      const row = canonical ? catalog.get(canonical) : catalog.get(id);
      data.push({
        id,
        object: 'model',
        created,
        owned_by: row?.provider ?? 'ai-gateway',
        capabilities: row?.capabilities ?? [],
        ...(canonical ? { canonical_id: canonical } : {}),
      });
    };
    for (const name of names) {
      const row = catalog.get(name);
      emit(name, null);
      // latest 别名与目录显式别名同样可被调用（resolveAlias 会在路由前解析回规范名）
      emit(`${name}:latest`, name);
      for (const alias of row?.aliases ?? []) emit(alias, name);
    }
    res.json({ object: 'list', data });
  }

  @ApiOperation({ summary: 'OpenAI 兼容对话补全（支持 stream 流式 SSE）' })
  @Post('chat/completions')
  @HttpCode(200)
  async chatCompletions(
    @Req() req: GatewayRequest,
    @Res() res: Response,
    @Body() body: Record<string, any>,
  ) {
    return this.executeChat(req, res, body, 'openai');
  }

  /** Anthropic Messages API：入站转换为内部 OpenAI 协议，出站（响应/SSE/错误）再翻译回 Anthropic */
  @ApiOperation({ summary: 'Anthropic Messages API（请求/响应/SSE 双向协议自动转换）' })
  @Post('messages')
  @HttpCode(200)
  async messages(
    @Req() req: GatewayRequest,
    @Res() res: Response,
    @Body() body: Record<string, any>,
  ) {
    if (!body?.model) {
      return res
        .status(400)
        .json(toAnthropicErrorBody('model: field required', 'invalid_request_error'));
    }
    if (body.max_tokens == null) {
      return res
        .status(400)
        .json(toAnthropicErrorBody('max_tokens: field required', 'invalid_request_error'));
    }
    return this.executeChat(req, res, anthropicToOpenAiRequest(body), 'anthropic');
  }

  /** OpenAI 兼容 embeddings：向量化透传，按输入 token 计费（无输出 token） */
  @ApiOperation({
    summary: 'OpenAI 兼容 embeddings（向量化；按输入 token 计费，支持故障转移）',
  })
  @Post('embeddings')
  @HttpCode(200)
  async embeddings(
    @Req() req: GatewayRequest,
    @Res() res: Response,
    @Body() body: Record<string, any>,
  ) {
    return this.executeEmbeddings(req, res, body);
  }

  /** OpenAI 兼容图片生成：按次计费（未配置按次价则回退 token 计价） */
  @ApiOperation({
    summary: 'OpenAI 兼容图片生成（/images/generations，按次计费，支持故障转移）',
  })
  @Post('images/generations')
  @HttpCode(200)
  async imagesGenerations(
    @Req() req: GatewayRequest,
    @Res() res: Response,
    @Body() body: Record<string, any>,
  ) {
    return this.executeImages(req, res, body);
  }

  /** OpenAI 兼容视频生成：异步任务（建任务 → 查状态 → 取内容），按次计费 */
  @ApiOperation({
    summary: 'OpenAI 兼容视频生成任务（/videos，异步，按次计费，支持故障转移）',
  })
  @Post('videos')
  @HttpCode(200)
  async videosCreate(
    @Req() req: GatewayRequest,
    @Res() res: Response,
    @Body() body: Record<string, any>,
  ) {
    return this.executeVideoCreate(req, res, body);
  }

  @ApiOperation({ summary: '视频任务状态（/videos/{id}）' })
  @Get('videos/:id')
  async videoTaskStatus(
    @Req() req: GatewayRequest,
    @Res() res: Response,
    @Param('id') id: string,
  ) {
    return this.executeVideoStatus(req, res, id);
  }

  @ApiOperation({ summary: '视频内容（/videos/{id}/content，二进制流透传）' })
  @Get('videos/:id/content')
  async videoTaskContent(
    @Req() req: GatewayRequest,
    @Res() res: Response,
    @Param('id') id: string,
  ) {
    return this.executeVideoContent(req, res, id);
  }

  /** 兼容格式建任务：{model,prompt,duration,image} → {task_id,status}；与 /videos 同链路（计费/故障转移/任务登记），只做协议适配 */
  @ApiOperation({ summary: '视频生成（兼容格式 /video/generations，按次计费，支持故障转移）' })
  @Post('video/generations')
  @HttpCode(200)
  async videoGenerationsCreate(
    @Req() req: GatewayRequest,
    @Res() res: Response,
    @Body() body: Record<string, any>,
  ) {
    return this.executeVideoCreate(req, res, videoCompatRequestBody(body), (json) =>
      videoCompatCreateResponse(json),
    );
  }

  @ApiOperation({ summary: '视频生成任务状态（兼容格式 /video/generations/{task_id}）' })
  @Get('video/generations/:taskId')
  async videoGenerationsStatus(
    @Req() req: GatewayRequest,
    @Res() res: Response,
    @Param('taskId') taskId: string,
  ) {
    return this.executeVideoStatus(req, res, taskId, (json) =>
      videoCompatStatusResponse(json, this.videoContentUrl(req, taskId)),
    );
  }

  /** 兼容格式状态响应里的成片直链 → 我们的内容端点（客户端沿用同一把 API key 下载） */
  private videoContentUrl(req: GatewayRequest, taskId: string): string {
    const host = req.get('host');
    if (!host) return '';
    return `${req.protocol}://${host}/v1/videos/${encodeURIComponent(taskId)}/content`;
  }

  private async executeChat(
    req: GatewayRequest,
    res: Response,
    body: Record<string, any>,
    apiFormat: 'openai' | 'anthropic',
  ) {
    /** 按客户端协议返回错误体 */
    const err = (
      message: string,
      type = 'invalid_request_error',
      code: string | null = null,
    ) =>
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
      Number(body?.max_tokens ?? body?.max_completion_tokens ?? 0) ||
      this.defaultMaxOutputTokens;
    let insufficientBalance = false;

    // 客户端断开时中止上游请求，避免连接泄漏（closeTracker 仅在提前断开时置位，正常完成的 close 不算）
    const upstreamAbort = new AbortController();
    const closeTracker = trackClientClose(res, () => upstreamAbort.abort());

    for (let i = 0; i < channels.length; i++) {
      const { channel, apiKey: upstreamKey, upstreamModelName, pricing } = channels[i];
      // 模型映射：对外规范名 → 上游真实名（渠道×模型未配置则用规范名）
      const upstreamModel = upstreamModelName ?? model;
      const upstreamBody =
        upstreamModel === model ? body : { ...body, model: upstreamModel };
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
        });
        const usage = result.usage ?? this.estimateUsage(body, result.json);
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
            responsePreview: this.logContent
              ? extractAssistantText(result.json)
              : null,
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
        return res
          .status(result.status)
          .json(
            apiFormat === 'anthropic'
              ? openAiToAnthropicResponse(result.json, model)
              : result.json,
          );
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
        err(
          lastError ? upstreamErrorMessage(lastError) : 'All channels failed',
          'upstream_error',
        ),
      );
  }

  /**
   * embeddings 执行：与 executeChat 同构（别名→能力→路由→预授权→故障转移→计费/健康/指标），
   * 差异：只走非流式单跳；input 为 string / string[] / token id 数组；无输出 token；
   * 只有实现了 embeddingsNonStream 的服务商（当前为 OpenAI 兼容类）参与候选。
   */
  private async executeEmbeddings(
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

  /**
   * 图片生成执行：与 embeddings 同构（别名→能力→路由→预授权→故障转移→计费/健康/指标）。
   * 计费：配置了按次价（目录 perCallPrice / 渠道 pricePerCall）则按次计费（×张数 ×倍率）；
   * 否则回退 token 计价（如 gpt-image 系列上游返回 usage）。
   */
  private async executeImages(
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
    const prompt = body?.prompt;
    if (typeof prompt !== 'string' || !prompt.trim()) {
      return res
        .status(400)
        .json(err('Missing required field: prompt (non-empty string)'));
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
      const { channel, apiKey: upstreamKey, upstreamModelName, pricing } = channels[i];
      // 模型映射：对外规范名 → 上游真实名
      const upstreamModel = upstreamModelName ?? model;
      const upstreamBody =
        upstreamModel === model ? body : { ...body, model: upstreamModel };
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
        });
        const perCall = pricePerCall > 0;
        const usage = result.usage ?? {
          promptTokens: 0,
          completionTokens: 0,
          totalTokens: 0,
        };
        const images = Array.isArray(result.json?.data)
          ? result.json.data.length
          : n;
        // 计费/健康度/路由指标互不依赖 → 并行落地
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
            responsePreview: `[images ${images}]`,
            multiplier: billingInfo.value,
            multiplierSource: billingInfo.source,
            pricing,
            ...(perCall
              ? {
                  costOverride: pricePerCall * n * billingInfo.value,
                  upstreamCostOverride: costPerCall * n,
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
        err(
          lastError ? upstreamErrorMessage(lastError) : 'All channels failed',
          'upstream_error',
        ),
      );
  }

  /**
   * 视频生成执行：与图片同构（别名→能力→路由→预授权→故障转移→按次计费），
   * 差异在于上游是**异步任务**：这里只负责建任务并按次落账，
   * 后续状态/内容查询走 GET /v1/videos/{id}（不再重复计费）。
   */
  private async executeVideoCreate(
    req: GatewayRequest,
    res: Response,
    body: Record<string, any>,
    /** 可选响应体映射：兼容格式入口把 OpenAI 形状换成 {task_id,status} */
    mapResponse?: (json: Record<string, any>) => Record<string, any>,
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
    const prompt = body?.prompt;
    if (typeof prompt !== 'string' || !prompt.trim()) {
      return res
        .status(400)
        .json(err('Missing required field: prompt (non-empty string)'));
    }

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
    if (!(await this.assertVideoCapable(model, res, err))) return;

    // 倍率 / 路由互不依赖 → 并行
    const [billingInfo, channels] = await Promise.all([
      this.billing.getBillingMultiplier(user.id, group.ratio, user),
      this.resolver.resolve(user.id, model, {
        strategy: apiKey.routingStrategy,
        stickyKey: this.support.buildStickyKey(req, user.id, body),
        groupId: group.id,
      }),
    ]);
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
    const requestPreview = this.logContent ? String(prompt).slice(0, 500) : '';
    let lastError: UpstreamError | null = null;
    let insufficientBalance = false;
    let unsupported = false;
    const guards = this.support.balanceGuards(user.id, billingInfo.value);

    // 客户端断开时中止上游请求，避免连接泄漏（closeTracker 仅在提前断开时置位）
    const upstreamAbort = new AbortController();
    const closeTracker = trackClientClose(res, () => upstreamAbort.abort());

    for (let i = 0; i < channels.length; i++) {
      const { channel, apiKey: upstreamKey, upstreamModelName, pricing } = channels[i];
      const upstreamModel = upstreamModelName ?? model;
      const upstreamBody =
        upstreamModel === model ? body : { ...body, model: upstreamModel };
      const provider = this.providers.resolve(channel.provider);
      if (typeof provider.videosCreate !== 'function') {
        unsupported = true; // 未实现视频透传的服务商 → 换下一家
        continue;
      }
      const pricePerCall = pricing.pricePerCall;
      const costPerCall = pricing.costPerCall;
      // 预授权：按次价 × 倍率（未配置按次价时不做预授权）
      if (this.support.isChargeable(channel, user.id) && pricePerCall > 0) {
        const required = pricePerCall * billingInfo.value;
        if ((await guards.getBalance()) < required) {
          insufficientBalance = true;
          continue;
        }
      }
      const attemptStart = Date.now();
      try {
        const result = await provider.videosCreate(channel, upstreamKey, {
          model: upstreamModel,
          body: upstreamBody,
          signal: upstreamAbort.signal,
        });
        const usage =
          result.usage ?? { promptTokens: 0, completionTokens: 0, totalTokens: 0 };
        const perCall = pricePerCall > 0;
        const taskId = typeof result.json?.id === 'string' ? result.json.id : '';
        if (taskId) {
          // 记住任务落在哪家上游：状态/内容查询必须问同一家
          this.videoTasks.remember(taskId, {
            channelId: channel.id,
            model,
            userId: user.id,
          });
        }
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
            responsePreview: taskId ? `[video task ${taskId}]` : '[video task]',
            multiplier: billingInfo.value,
            multiplierSource: billingInfo.source,
            pricing,
            ...(perCall
              ? {
                  costOverride: pricePerCall * billingInfo.value,
                  upstreamCostOverride: costPerCall,
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
        return res
          .status(result.status)
          .json(mapResponse ? mapResponse(result.json) : result.json);
      } catch (e) {
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
            `Model "${model}": no upstream with video generation support among available channels ` +
              '(/v1/videos is forwarded to openai-compatible providers only).',
            'invalid_request_error',
            'videos_not_supported',
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

  /** 视频任务状态查询：定位建任务的渠道并透传（不计费、不计路由指标，避免轮询污染统计） */
  private async executeVideoStatus(
    req: GatewayRequest,
    res: Response,
    taskId: string,
    /** 可选响应体映射：兼容格式入口换字段形状（url/format/metadata） */
    mapResponse?: (json: Record<string, any>) => Record<string, any>,
  ) {
    const err = (
      message: string,
      type = 'invalid_request_error',
      code: string | null = null,
    ) => openaiError(message, type, code);
    if (!VIDEO_TASK_ID_RE.test(taskId)) {
      return res.status(400).json(err('Invalid video task id'));
    }

    const candidates = await this.videoCandidates(req, taskId);
    let lastError: UpstreamError | null = null;
    for (const { c, model: resolvedModel } of candidates) {
      const provider = this.providers.resolve(c.channel.provider);
      if (typeof provider.videoStatus !== 'function') continue;
      try {
        const result = await provider.videoStatus(c.channel, c.apiKey, { taskId });
        const model =
          typeof result.json?.model === 'string' ? result.json.model : resolvedModel;
        // 回填映射：下次（含重启后）直接命中
        this.videoTasks.remember(taskId, {
          channelId: c.channel.id,
          model,
          userId: req.gateway.user.id,
        });
        return res
          .status(result.status)
          .json(mapResponse ? mapResponse(result.json) : result.json);
      } catch (e) {
        if (e instanceof UpstreamError) {
          lastError = e;
          continue;
        }
        throw e;
      }
    }
    return this.videoTaskNotFound(res, err, taskId, lastError);
  }

  /** 视频内容透传：二进制流直接转发（不计费） */
  private async executeVideoContent(req: GatewayRequest, res: Response, taskId: string) {
    const err = (
      message: string,
      type = 'invalid_request_error',
      code: string | null = null,
    ) => openaiError(message, type, code);
    if (!VIDEO_TASK_ID_RE.test(taskId)) {
      return res.status(400).json(err('Invalid video task id'));
    }

    const candidates = await this.videoCandidates(req, taskId);
    let lastError: UpstreamError | null = null;
    for (const { c } of candidates) {
      const provider = this.providers.resolve(c.channel.provider);
      if (typeof provider.videoContent !== 'function') continue;
      try {
        const upstream = await provider.videoContent(c.channel, c.apiKey, { taskId });
        res.status(upstream.status);
        res.setHeader('Content-Type', upstream.contentType);
        if (upstream.contentLength) {
          res.setHeader('Content-Length', upstream.contentLength);
        }
        await pipeline(
          Readable.fromWeb(upstream.stream as Parameters<typeof Readable.fromWeb>[0]),
          res,
        );
        return;
      } catch (e) {
        if (res.headersSent) return; // 已开始写流：不能再改写响应
        if (e instanceof UpstreamError) {
          lastError = e;
          continue;
        }
        throw e;
      }
    }
    return this.videoTaskNotFound(res, err, taskId, lastError);
  }

  private videoTaskNotFound(
    res: Response,
    err: (message: string, type?: string, code?: string | null) => any,
    taskId: string,
    lastError: UpstreamError | null,
  ) {
    return res
      .status(lastError?.status === 404 ? 404 : (lastError?.status ?? 404))
      .json(
        err(
          lastError
            ? upstreamErrorMessage(lastError)
            : `Video task "${taskId}" was not found on any available channel.`,
          'invalid_request_error',
          'video_task_not_found',
        ),
      );
  }

  /**
   * 视频渠道候选（按序尝试）：
   * ① 建任务时记住的渠道；② 映射缺失（发布重启/多副本）时，用「目录里标了 video 能力的模型」
   * 逐个路由探测 —— 任务 id 只在上游自家有效，探测失败（404）成本很低。
   */
  private async videoCandidates(
    req: GatewayRequest,
    taskId: string,
  ): Promise<Array<{ c: ResolvedChannel; model: string }>> {
    const { user, apiKey } = req.gateway;
    const hit = this.videoTasks.lookup(taskId);
    const group = await this.groups.effectiveGroup(user, apiKey.groupId);
    const seen = new Set<string>();
    const out: Array<{ c: ResolvedChannel; model: string }> = [];
    const add = (list: ResolvedChannel[], model: string) => {
      for (const c of list) {
        if (seen.has(c.channel.id)) continue;
        seen.add(c.channel.id);
        out.push({ c, model });
      }
    };
    if (hit) {
      add(
        await this.resolver.resolve(user.id, hit.model, {
          strategy: apiKey.routingStrategy,
          groupId: group.id,
        }),
        hit.model,
      );
    }
    if (out.length === 0) {
      for (const name of await this.resolver.videoModelNames()) {
        add(
          await this.resolver.resolve(user.id, name, {
            strategy: apiKey.routingStrategy,
            groupId: group.id,
          }),
          name,
        );
      }
    }
    return out;
  }

  /**
   * 视频能力校验：目录里显式标了能力（非空）但不含 video → 400，
   * 避免把纯文本模型按视频协议打到上游（能力为空 = 不限制，与其它端点同口径）。
   */
  private async assertVideoCapable(
    model: string,
    res: Response,
    err: (message: string, type?: string, code?: string | null) => any,
  ): Promise<boolean> {
    const meta = await this.resolver.catalogFor([model]);
    const caps = meta.get(model)?.capabilities;
    if (caps && caps.length > 0 && !caps.includes('video')) {
      res
        .status(400)
        .json(
          err(
            `Model "${model}" is not a video model (capabilities: ${caps.join(', ')}).`,
            'invalid_request_error',
            'video_not_supported',
          ),
        );
      return false;
    }
    return true;
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
      if (errorMessage) {
        tasks.push(
          this.health.recordFailure(meta.channel.id, errorMessage),
          this.metrics.record(meta.channel.id, meta.model, 'error', {
            latencyMs,
            status: 500,
            totalTokens: usage.totalTokens,
            errorMessage,
          }),
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
    await Promise.all(tasks);

    if (!res.writableEnded) res.end();
  }
}
