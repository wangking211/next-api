/**
 * 网关执行内核：控制器与各能力执行器（chat/embeddings/images/video）共享的横切逻辑。
 * - 收费/分成判定：isSharedFromOthers / isChargeable / shareContext（预授权与落账必须同口径）
 * - 余额与倍率预读：balanceGuards（同请求多候选共享缓存，避免重复查库）
 * - 能力校验：checkCapabilities（目录声明 capabilities 时，请求所需能力必须被覆盖）
 * - 会话粘性键：buildStickyKey（显式 session id 优先，否则 用户+prompt 前缀，保住上游 prompt cache）
 * - 上游失败统一处理：handleUpstreamFailure（错误分类 → 健康度/路由指标 → 可转移返回 continue）
 * 共享分成口径的行为特征化见 gateway.share-context.spec.ts。
 */
import { Injectable } from '@nestjs/common';
import type { Response } from 'express';
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
import {
  upstreamErrorMessage,
  upstreamErrorSignal,
  isModelAccessDenied,
  isRateLimited,
  isRefusal,
} from './upstream-error.util';

@Injectable()
export class ExecSupportService {
  constructor(
    private readonly resolver: ChannelResolverService,
    private readonly usage: UsageService,
    private readonly billing: BillingService,
    private readonly health: ChannelHealthService,
    private readonly metrics: RoutingMetricsService,
  ) {}

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
        ),
      );
    return false;
  }

  /**
   * 上游失败统一处理（chat 与 embeddings 共用）：错误分类 → 记录健康度/路由指标 →
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
    const signal = upstreamErrorSignal(e) || e.message;
    // 错误分类（客户端 4xx 不计健康度，防止被恶意请求自动禁用渠道）：
    //  限流/超限 → 冷却退避且不累计失败；5xx/连接故障 → 健康度失败计数；
    //  上游鉴权失败(401) → 只降路由质量分；拒答/内容过滤 → 只降质量分
    const limited = isRateLimited(e);
    const transient = e.retryable && !limited;
    const authFault = !limited && e.status === 401;
    const modelDenied = !limited && !authFault && isModelAccessDenied(e);
    const refusal = !limited && !transient && !authFault && !modelDenied && isRefusal(e);
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
    ctx.res.status(e.status || 502).json(ctx.errorBody(upstreamErrorMessage(e), 'upstream_error'));
    return 'responded';
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
