/**
 * 视频能力执行器：/v1/videos 与兼容 /v1/video/generations 的建任务/查状态/取内容。
 * 按次计费、故障转移、任务落点登记（状态/内容查询必须回同一家上游）与二进制流透传。
 */
import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { Response } from 'express';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
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
import { VideoTaskService } from './video-task.service';
import { upstreamErrorMessage } from './upstream-error.util';
import { UpstreamError, openaiError } from './types';
import type { GatewayRequest, ResolvedChannel } from './types';

/** 视频任务 id 只允许安全字符：防止路径穿越把请求打到上游的其它端点 */
const VIDEO_TASK_ID_RE = /^[A-Za-z0-9._:-]{1,128}$/;

@Injectable()
export class VideoExecutorService {
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
    this.logContent = config.get<string>('LOG_CONTENT', 'false') !== 'false';
  }

  /**
   * 视频生成执行：与图片同构（别名→能力→路由→预授权→故障转移→按次计费），
   * 差异在于上游是**异步任务**：这里只负责建任务并按次落账，
   * 后续状态/内容查询走 GET /v1/videos/{id}（不再重复计费）。
   */
  async executeVideoCreate(
    req: GatewayRequest,
    res: Response,
    body: Record<string, any>,
    /** 可选响应体映射：兼容格式入口把 OpenAI 形状换成 {task_id,status} */
    mapResponse?: (json: Record<string, any>) => Record<string, any>,
  ) {
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
      const upstreamBody = upstreamModel === model ? body : { ...body, model: upstreamModel };
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
        const usage = result.usage ?? { promptTokens: 0, completionTokens: 0, totalTokens: 0 };
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
        // 先把响应写出去：客户端不必等 DB 事务 + Redis 写完
        const response = res
          .status(result.status)
          .json(mapResponse ? mapResponse(result.json) : result.json);
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
        return response;
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
        err(lastError ? upstreamErrorMessage(lastError) : 'All channels failed', 'upstream_error'),
      );
  }

  /** 视频任务状态查询：定位建任务的渠道并透传（不计费、不计路由指标，避免轮询污染统计） */
  async executeVideoStatus(
    req: GatewayRequest,
    res: Response,
    taskId: string,
    /** 可选响应体映射：兼容格式入口换字段形状（url/format/metadata） */
    mapResponse?: (json: Record<string, any>) => Record<string, any>,
  ) {
    const err = (message: string, type = 'invalid_request_error', code: string | null = null) =>
      openaiError(message, type, code);
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
        const model = typeof result.json?.model === 'string' ? result.json.model : resolvedModel;
        // 回填映射：下次（含重启后）直接命中
        this.videoTasks.remember(taskId, {
          channelId: c.channel.id,
          model,
          userId: req.gateway.user.id,
        });
        return res.status(result.status).json(mapResponse ? mapResponse(result.json) : result.json);
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
  async executeVideoContent(req: GatewayRequest, res: Response, taskId: string) {
    const err = (message: string, type = 'invalid_request_error', code: string | null = null) =>
      openaiError(message, type, code);
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

  /** 兼容格式状态响应里的成片直链 → 我们的内容端点（客户端沿用同一把 API key 下载） */
  videoContentUrl(req: GatewayRequest, taskId: string): string {
    const host = req.get('host');
    if (!host) return '';
    return `${req.protocol}://${host}/v1/videos/${encodeURIComponent(taskId)}/content`;
  }
}
