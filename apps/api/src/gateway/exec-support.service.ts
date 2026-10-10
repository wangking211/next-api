/**
 * 网关执行内核：控制器与各能力执行器（chat/embeddings/images/video）共享的横切逻辑。
 * - 收费/分成判定：isSharedFromOthers / isChargeable / shareContext（预授权与落账必须同口径）
 * - 余额与倍率预读：balanceGuards（同请求多候选共享缓存，避免重复查库）
 * - 能力校验：checkCapabilities（目录声明 capabilities 时，请求所需能力必须被覆盖）
 * - 会话粘性键：buildStickyKey（显式 session id 优先，否则 用户+prompt 前缀，保住上游 prompt cache）
 * - 上游失败统一处理：classifyUpstreamFailure（纯分类）→ recordOutcomes（健康度/路由指标，
 *   含模型级故障豁免与拒答不计失败）→ handleUpstreamFailure（可转移返回 continue）
 * - 整请求 deadline：deadlineLeft / attemptTimeoutMs / respondDeadline（跨故障转移共享总预算）
 * 共享分成口径的行为特征化见 gateway.share-context.spec.ts。
 */
import { Injectable } from '@nestjs/common';
import type { Response } from 'express';
import { ConfigService } from '@nestjs/config';
import { Channel, ChannelOwnerType, ChannelShareMode } from '@prisma/client';
import { BillingService } from '../billing/billing.service';
import type { ChannelPricing } from '../billing/pricing.util';
import { UsageService } from '../usage/usage.service';
import type { UsageEntry } from '../usage/usage.service';
import { ChannelResolverService } from './channel-resolver.service';
import { ChannelHealthService } from './channel-health.service';
import { RoutingMetricsService } from './routing-metrics.service';
import { detectRequiredCapabilities } from './capabilities';
import { settleInBackground } from './settle.util';
import type { GatewayRequest, UpstreamError } from './types';
import { DEFAULT_UPSTREAM_TIMEOUT_MS } from './providers/stream.util';
import {
  upstreamErrorMessage,
  classifyUpstreamFailure,
  type FailureClass,
} from './upstream-error.util';

@Injectable()
export class ExecSupportService {
  /** 整请求 deadline：跨故障转移共享的总预算（毫秒）；<=0 表示关闭 */
  readonly deadlineMs: number;

  constructor(
    private readonly resolver: ChannelResolverService,
    private readonly usage: UsageService,
    private readonly billing: BillingService,
    private readonly health: ChannelHealthService,
    private readonly metrics: RoutingMetricsService,
    config: ConfigService,
  ) {
    const d = Number(config.get<string>('GATEWAY_DEADLINE_MS', '300000'));
    this.deadlineMs = Number.isFinite(d) && d > 0 ? d : 0;
  }

  /**
   * 该渠道是否是「他人上架的共享渠道」——决定收费与分成口径。
   * 自有渠道（含自己上架的）走 BYOK：不收费、不分成（消耗的是自己的上游额度）。
   */
  private isSharedFromOthers(channel: Channel, callerUserId: string): boolean {
    return (
      channel.ownerType === ChannelOwnerType.USER &&
      channel.shareMode !== ChannelShareMode.PRIVATE &&
      !!channel.ownerUserId &&
      channel.ownerUserId !== callerUserId
    );
  }

  /**
   * 本次调用是否向调用方收费：
   * - 平台渠道：收费
   * - 他人已上架的共享渠道：收费（实收按比例分给渠道主）
   * - 自己的 BYOK 渠道：免费
   * 预授权与落账必须用同一判定，否则会出现「不预授权但扣费」的白嫖窗口。
   */
  isChargeable(channel: Channel, callerUserId: string): boolean {
    return (
      channel.ownerType === ChannelOwnerType.PLATFORM ||
      this.isSharedFromOthers(channel, callerUserId)
    );
  }

  /** 共享分成上下文（落账时给渠道主入账用）；非共享场景返回 undefined */
  shareContext(channel: Channel, callerUserId: string): UsageEntry['share'] {
    if (!this.isSharedFromOthers(channel, callerUserId)) return undefined;
    return {
      ownerUserId: channel.ownerUserId as string,
      feeBps: this.billing.channelShareFeeBps(channel),
    };
  }

  /** 余额/倍率按用户缓存（同一次请求的多个候选渠道共享，避免重复查库） */
  balanceGuards(userId: string, presetMultiplier?: number) {
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
  async checkCapabilities(
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
    res
      .status(400)
      .json(
        err(
          `Model "${model}" does not support: ${missing.join(', ')}. ` +
            `Declared capabilities: ${declared.join(', ')}.`,
          'invalid_request_error',
          'capability_not_supported',
        ),
      );
    return false;
  }

  /**
   * 按分类写健康度与路由指标——handleUpstreamFailure 与流式中断（响应头已发出、
   * 无法故障转移）两条路径共用同一口径：
   * - limited → 记 429 现场（不计失败）+ (渠道,模型) 冷却（含 Retry-After 退避）
   * - transient → 渠道失败计数 + (渠道,模型) 熔断；模型级故障豁免只记现场不计数
   * - modelDenied → 只冷却该 (渠道,模型) 组合
   * - authFault → 记路由指标（连带熔断）；refusal → 只降质量分，不计失败、不熔断
   */
  async recordOutcomes(
    channel: Channel,
    model: string,
    cls: FailureClass,
    args: {
      latencyMs: number;
      errorMessage: string;
      /** 显式状态码；缺省用分类里的上游状态 */
      status?: number;
      completionTokens?: number;
      totalTokens?: number;
    },
  ): Promise<void> {
    const status = args.status ?? cls.status;
    const metric = {
      latencyMs: args.latencyMs,
      status,
      errorMessage: args.errorMessage,
      ...(args.completionTokens !== undefined ? { completionTokens: args.completionTokens } : {}),
      ...(args.totalTokens !== undefined ? { totalTokens: args.totalTokens } : {}),
    };
    if (cls.limited) {
      await this.health.recordRateLimited(channel.id, args.errorMessage);
      await this.metrics.record(channel.id, model, 'rate_limited', {
        ...metric,
        retryAfterMs: cls.retryAfterMs,
      });
      return;
    }
    if (cls.transient) {
      const scoped = await this.isModelScopedFailure(channel, model);
      await this.health.recordFailure(channel.id, args.errorMessage, { count: !scoped });
      await this.metrics.record(channel.id, model, 'error', metric);
      return;
    }
    if (cls.modelDenied) {
      await this.metrics.record(channel.id, model, 'model_denied', metric);
      return;
    }
    if (cls.authFault || cls.refusal) {
      await this.metrics.record(channel.id, model, cls.authFault ? 'error' : 'refused', metric);
    }
  }

  /**
   * 模型级故障豁免：渠道配置了其它模型且它们在窗口期内成功过 → 当前失败只该冷却
   * (渠道,模型)，不该累计渠道 failureCount（否则一条坏模型会连坐禁用整条渠道）。
   * 单模型渠道（或未配置模型列表）：模型故障 ≡ 渠道故障，维持原计数。
   */
  private async isModelScopedFailure(channel: Channel, model: string): Promise<boolean> {
    const others = (channel.models ?? []).filter((m) => m !== model);
    if (!others.length) return false;
    return this.metrics.hasRecentSuccessOutside(channel.id, model);
  }

  /**
   * 上游失败统一处理（chat 与 embeddings/images/video 共用）：分类 → 记录健康度/路由指标 →
   * 可故障转移则返回 'continue'（调用方试下一家），否则落用量日志并写出错误响应。
   */
  async handleUpstreamFailure(
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
    // 错误分类（客户端 4xx 不计健康度，防止被恶意请求自动禁用渠道）：
    //  限流/超限 → 冷却退避且不累计失败；5xx/连接故障 → 健康度失败计数（模型级故障豁免）；
    //  上游鉴权失败(401) → 只降路由质量分；拒答/内容过滤 → 只降质量分，且换下一家再试
    const cls = classifyUpstreamFailure(e);
    await this.recordOutcomes(ctx.channel, ctx.model, cls, {
      latencyMs,
      errorMessage: cls.signal,
    });
    // 故障转移：上游故障、限流/超限、鉴权失效、无权访问该模型、拒答都换下一家试
    //（拒答换供应商常有不同审核宽严，换一家可能正常出量；全部候选才返回错误）
    if (
      (cls.transient || cls.limited || cls.authFault || cls.modelDenied || cls.refusal) &&
      ctx.hasMore
    ) {
      return 'continue';
    }
    // 错误响应同样不该等落库：落账转后台结算（allSettled 兜底，不产生未处理拒绝）
    settleInBackground([
      this.usage.record({
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
        chargeable: this.isChargeable(ctx.channel, ctx.userId),
        share: this.shareContext(ctx.channel, ctx.userId),
        isStream: ctx.isStream,
        requestPreview: ctx.requestPreview,
        pricing: ctx.pricing,
        multiplier: ctx.multiplier,
        multiplierSource: ctx.multiplierSource,
      }),
    ]);
    if (cls.modelDenied) {
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
    ctx.res.status(e.status || 502).json(ctx.errorBody(upstreamErrorMessage(e), 'upstream_error'));
    return 'responded';
  }

  /**
   * 整请求剩余预算（毫秒）：所有候选尝试共享的总时长上限。
   * deadline 关闭（GATEWAY_DEADLINE_MS<=0）→ Infinity。流式响应头发出后由空闲超时接管，
   * 不再受此限（避免砍掉正常进行中的长流）。
   */
  deadlineLeft(startedAt: number): number {
    if (!this.deadlineMs) return Number.POSITIVE_INFINITY;
    return Math.max(0, this.deadlineMs - (Date.now() - startedAt));
  }

  /** 单次尝试的上游超时：默认 120s，且不超过整请求剩余预算（故障转移越多，单次窗口越紧） */
  attemptTimeoutMs(startedAt: number): number {
    return Math.min(DEFAULT_UPSTREAM_TIMEOUT_MS, this.deadlineLeft(startedAt));
  }

  /** 预算耗尽 → 504（错误体形态由调用方按 openai/anthropic 协议提供） */
  respondDeadline(
    res: Response,
    err: (message: string, type?: string, code?: string | null) => any,
  ): void {
    res
      .status(504)
      .json(
        err(
          `Request deadline exceeded: total gateway budget of ${this.deadlineMs}ms spent across attempts.`,
          'upstream_error',
          'gateway_timeout',
        ),
      );
  }

  /**
   * 会话粘性键：显式 x-session-id 优先（前端可传会话 ID），否则用 用户 + prompt 前缀。
   * 同键请求倾向落同一渠道，保住上游 prompt cache；跨会话/跨请求则自然分散。
   */
  buildStickyKey(req: GatewayRequest, userId: string, body: Record<string, any>): string {
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
}
