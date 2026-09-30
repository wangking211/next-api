import {
  Body,
  Controller,
  Get,
  HttpCode,
  Post,
  Req,
  Res,
  UseFilters,
  UseGuards,
} from '@nestjs/common';
import { Response } from 'express';
import { ConfigService } from '@nestjs/config';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { ApiKeyGuard } from './guards/api-key.guard';
import { GatewayErrorFilter } from './gateway-error.filter';
import { ChannelResolverService } from './channel-resolver.service';
import { ProviderRegistry } from './providers/provider.registry';
import { ChannelHealthService } from './channel-health.service';
import { RoutingMetricsService } from './routing-metrics.service';
import { GatewayAuthContext, GatewayRequest, StreamResult, UpstreamError, openaiError } from './types';
import { detectRequiredCapabilities } from './capabilities';
import {
  AnthropicStreamTranslator,
  anthropicToOpenAiRequest,
  openAiToAnthropicResponse,
  toAnthropicErrorBody,
} from './anthropic-format';
import { UsageService } from '../usage/usage.service';
import { BillingService } from '../billing/billing.service';
import type { ChannelPricing } from '../billing/pricing.util';
import { GroupsService } from '../groups/groups.service';
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

/**
 * 上游「令牌无权访问该模型」特征（new-api 分组未开通等）：属配置问题，
 * 应换下一家上游试（可能别家有权限），并返回明确的 model_not_found，
 * 且只冷却「该渠道 × 该模型」，不误禁整条渠道。
 */
const MODEL_ACCESS_RE =
  /(no access to model|model[_\s-]?not[_\s-]?found|not have access|no permission|permission denied|not authorized|unsupported model|无权访问|没有权限|无权限|未开通|权限不足)/i;

function isModelAccessDenied(e: UpstreamError): boolean {
  if (e.status !== 403 && e.status !== 404) return false;
  return MODEL_ACCESS_RE.test(upstreamErrorSignal(e));
}

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
        stickyKey: this.buildStickyKey(req, user.id, body),
        groupId: group.id,
      }),
      this.checkCapabilities(model, body, res, err),
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
    const guards = this.balanceGuards(user.id, billingInfo.value);
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
      const { channel, apiKey: upstreamKey, upstreamModelName, pricing } = channels[i];
      // 模型映射：对外规范名 → 上游真实名（渠道×模型未配置则用规范名）
      const upstreamModel = upstreamModelName ?? model;
      const upstreamBody =
        upstreamModel === model ? body : { ...body, model: upstreamModel };
      if (channel.ownerType === ChannelOwnerType.PLATFORM) {
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
            chargeable: channel.ownerType === ChannelOwnerType.PLATFORM,
            abort: upstreamAbort,
            idleMs: this.streamIdleMs,
            isClientClosed: () => clientClosed,
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
            chargeable: channel.ownerType === ChannelOwnerType.PLATFORM,
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
        if (clientClosed) return;
        if (e instanceof UpstreamError) {
          lastError = e;
          const action = await this.handleUpstreamFailure(e, {
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

  /** 余额/倍率按用户缓存（同一次请求的多个候选渠道共享，避免重复查库） */
  private balanceGuards(userId: string, presetMultiplier?: number) {
    let cachedBalance: number | null = null;
    let cachedMultiplier: number | null = presetMultiplier ?? null;
    return {
      getBalance: async (): Promise<number> => {
        if (cachedBalance === null) {
          cachedBalance = (await this.billing.getBalance(userId)).balance;
        }
        return cachedBalance;
      },
      getUserMultiplier: async (): Promise<number> => {
        if (cachedMultiplier === null) {
          cachedMultiplier = await this.billing.getUserMultiplier(userId);
        }
        return cachedMultiplier;
      },
    };
  }

  /**
   * 能力校验：目录声明了 capabilities 时，请求所需能力必须被覆盖（未声明则放行）。
   * @returns true = 通过；false = 已写出 400 响应，调用方应直接 return。
   */
  private async checkCapabilities(
    model: string,
    body: Record<string, any>,
    res: Response,
    err: (message: string, type?: string, code?: string | null) => any,
  ): Promise<boolean> {
    const requiredCaps = detectRequiredCapabilities(body);
    if (!requiredCaps.length) return true;
    const cat = await this.resolver.catalogFor([model]);
    const declared = cat.get(model)?.capabilities ?? [];
    if (!declared.length) return true;
    const missing = requiredCaps.filter((c) => !declared.includes(c));
    if (!missing.length) return true;
    res.status(400).json(
      err(
        `Model "${model}" does not support: ${missing.join(', ')}. ` +
          `Declared capabilities: ${declared.join(', ')}.`,
        'invalid_request_error',
      ),
    );
    return false;
  }

  /**
   * 上游失败统一处理（chat 与 embeddings 共用）：错误分类 → 记录健康度/路由指标 →
   * 可故障转移则返回 'continue'（调用方试下一家），否则落用量日志并写出错误响应。
   */
  private async handleUpstreamFailure(
    e: UpstreamError,
    ctx: {
      res: Response;
      channel: Channel;
      model: string;
      attemptStart: number;
      startedAt: number;
      userId: string;
      apiKeyId: string;
      requestPreview: string;
      isStream: boolean;
      hasMore: boolean;
      /** 已解析的定价与倍率（随 resolve 结果带出）：失败落账同样免查 */
      pricing?: ChannelPricing;
      multiplier?: number;
      multiplierSource?: string;
      errorBody: (message: string, type?: string, code?: string | null) => any;
    },
  ): Promise<'continue' | 'responded'> {
    const latencyMs = Date.now() - ctx.attemptStart;
    const signal = upstreamErrorSignal(e) || e.message;
    // 错误分类（客户端 4xx 不计健康度，防止被恶意请求自动禁用渠道）：
    //  限流/超限 → 冷却退避且不累计失败；5xx/连接故障 → 健康度失败计数；
    //  上游鉴权失败(401) → 只降路由质量分；拒答/内容过滤 → 只降质量分
    const limited = isRateLimited(e);
    const transient = e.retryable && !limited;
    const authFault = !limited && e.status === 401;
    const modelDenied = !limited && !authFault && isModelAccessDenied(e);
    const refusal =
      !limited && !transient && !authFault && !modelDenied && isRefusal(e);
    if (limited) {
      await this.health.recordRateLimited(ctx.channel.id, signal);
      await this.metrics.record(ctx.channel.id, ctx.model, 'rate_limited', {
        latencyMs,
        status: e.status,
        errorMessage: signal,
      });
    } else if (transient) {
      await this.health.recordFailure(ctx.channel.id, e.message);
      await this.metrics.record(ctx.channel.id, ctx.model, 'error', {
        latencyMs,
        status: e.status,
        errorMessage: signal,
      });
    } else if (modelDenied) {
      // 无权访问该模型：只记 (渠道×模型) 指标并触发该组合的冷却，不计渠道健康度
      await this.metrics.record(ctx.channel.id, ctx.model, 'model_denied', {
        latencyMs,
        status: e.status,
        errorMessage: signal,
      });
    } else if (authFault || refusal) {
      await this.metrics.record(ctx.channel.id, ctx.model, authFault ? 'error' : 'refused', {
        latencyMs,
        status: e.status,
        errorMessage: signal,
      });
    }
    // 故障转移：上游故障、限流/超限、鉴权失效、无权访问该模型都要换下一家试
    if ((transient || limited || authFault || modelDenied) && ctx.hasMore) return 'continue';
    await this.usage.record({
      userId: ctx.userId,
      apiKeyId: ctx.apiKeyId,
      channelId: ctx.channel.id,
      model: ctx.model,
      provider: ctx.channel.provider,
      promptTokens: 0,
      completionTokens: 0,
      totalTokens: 0,
      latencyMs: Date.now() - ctx.startedAt,
      status: e.status || 502,
      errorMessage: e.message,
      chargeable: ctx.channel.ownerType === ChannelOwnerType.PLATFORM,
      isStream: ctx.isStream,
      requestPreview: ctx.requestPreview,
      pricing: ctx.pricing,
      multiplier: ctx.multiplier,
      multiplierSource: ctx.multiplierSource,
    });
    if (modelDenied) {
      // 所有候选上游都无该模型权限：返回明确的 model_not_found，而非透传上游 403 文案
      ctx.res
        .status(404)
        .json(
          ctx.errorBody(
            `No upstream channel has access to model "${ctx.model}". ` +
              'The configured upstream key/group does not include this model.',
            'model_not_found',
            'model_not_found',
          ),
        );
      return 'responded';
    }
    ctx.res
      .status(e.status || 502)
      .json(ctx.errorBody(upstreamErrorMessage(e), 'upstream_error'));
    return 'responded';
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
        stickyKey: this.buildStickyKey(req, user.id, body),
        groupId: group.id,
      }),
      this.checkCapabilities(model, body, res, err),
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
    const guards = this.balanceGuards(user.id, billingInfo.value);

    // 客户端断开时中止上游请求，避免连接泄漏
    const upstreamAbort = new AbortController();
    let clientClosed = false;
    res.on('close', () => {
      clientClosed = true;
      upstreamAbort.abort();
    });

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
      if (channel.ownerType === ChannelOwnerType.PLATFORM) {
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
            chargeable: channel.ownerType === ChannelOwnerType.PLATFORM,
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
        if (clientClosed) return;
        if (e instanceof UpstreamError) {
          lastError = e;
          const action = await this.handleUpstreamFailure(e, {
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
        stickyKey: this.buildStickyKey(req, user.id, body),
        groupId: group.id,
      }),
      this.checkCapabilities(model, body, res, err),
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
    const guards = this.balanceGuards(user.id, billingInfo.value);

    const upstreamAbort = new AbortController();
    let clientClosed = false;
    res.on('close', () => {
      clientClosed = true;
      upstreamAbort.abort();
    });

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
      if (
        channel.ownerType === ChannelOwnerType.PLATFORM &&
        pricePerCall > 0
      ) {
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
            chargeable: channel.ownerType === ChannelOwnerType.PLATFORM,
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
        if (clientClosed) return;
        if (e instanceof UpstreamError) {
          lastError = e;
          const action = await this.handleUpstreamFailure(e, {
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
   * 会话粘性键：显式 x-session-id 优先（前端可传会话 ID），否则用 用户 + prompt 前缀。   * 同键请求倾向落同一渠道，保住上游 prompt cache；跨会话/跨请求则自然分散。
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

    const clientClosed = meta.isClientClosed?.() ?? false;
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
          clientClosed ? undefined : (errorMessage ?? undefined),
        ))
          res.write(ev);
      }
    }

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
