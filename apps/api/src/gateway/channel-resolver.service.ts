import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Channel, ChannelOwnerType, ChannelStatus, Prisma, RoutingStrategy } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { CryptoService } from '../common/crypto.service';
import { ResolvedChannel } from './types';
import { RoutingMetricsService } from './routing-metrics.service';
import { GroupsService } from '../groups/groups.service';
import {
  DEFAULT_STRATEGY,
  applySticky,
  isRoutingStrategy,
  scoreCandidates,
} from './routing-score';

export interface RouteOptions {
  /** Key 级路由策略；缺省回退 ROUTING_STRATEGY 环境变量 */
  strategy?: RoutingStrategy | null;
  /** 会话粘性键：x-session-id，或 userId + prompt 前缀 */
  stickyKey?: string | null;
  /** 生效模型分组 id（渠道分组隔离）；null/缺省 = 不限制 */
  groupId?: string | null;
}

interface Candidate {
  id: string;
  c: ResolvedChannel;
  tier: number;
  priority: number;
  cost: number;
  weight: number;
  qualityScore: number;
}

@Injectable()
export class ChannelResolverService {
  private readonly logger = new Logger(ChannelResolverService.name);
  private readonly defaultStrategy: RoutingStrategy;
  private readonly stickyEnabled: boolean;
  private readonly stickyRatio: number;
  private readonly autoReenableMs: number;
  private readonly failureThreshold: number;
  private readonly debug: boolean;

  constructor(
    private readonly prisma: PrismaService,
    private readonly crypto: CryptoService,
    private readonly metrics: RoutingMetricsService,
    private readonly groups: GroupsService,
    config: ConfigService,
  ) {
    const s = config.get<string>('ROUTING_STRATEGY', DEFAULT_STRATEGY);
    this.defaultStrategy = isRoutingStrategy(s) ? s : DEFAULT_STRATEGY;
    this.stickyEnabled = config.get<string>('ROUTING_STICKY', 'true') !== 'false';
    const r = Number(config.get<string>('ROUTING_STICKY_RATIO', '0.8'));
    this.stickyRatio = Number.isFinite(r) && r > 0 && r <= 1 ? r : 0.8;
    this.autoReenableMs =
      Number(config.get<string>('CHANNEL_AUTO_REENABLE_MS', '900000')) || 900000;
    this.failureThreshold =
      Number(config.get<string>('CHANNEL_FAILURE_THRESHOLD', '5')) || 5;
    this.debug = config.get<string>('ROUTING_DEBUG') === 'true';
  }

  /** 半开恢复的冷却截止时刻（早于该时刻的自动禁用渠道重新进入候选） */
  private reenableCutoff(): Date {
    return new Date(Date.now() - this.autoReenableMs);
  }

  /** 渠道可用性条件：启用，或自动禁用已过冷却期（半开探测，进入候选后再触发恢复） */
  private availabilityWhere(cutoff: Date) {
    return {
      OR: [
        { status: ChannelStatus.ENABLED },
        {
          status: ChannelStatus.DISABLED,
          autoDisabled: true,
          lastErrorAt: { lt: cutoff },
        },
      ],
    };
  }

  /**
   * 为指定用户 + 模型选择候选渠道。
   *
   * 排序 = 硬分层 + 评分：tier（BYOK 优先）→ priority（人工指定）→ 五维评分降序。
   * 评分维度：价格 / 速度·性能 / 稳定性 / 质量（L1 人工分 + L2 被动信号）/ 分流噪声；
   * 无指标时各维度中性回退，整体退化为「成本升序 + 加权随机」，与旧排序兼容。
   */
  async resolve(
    userId: string,
    model: string,
    opts: RouteOptions = {},
  ): Promise<ResolvedChannel[]> {
    const groupCond = this.groups.channelVisibilityWhere(opts.groupId ?? null);
    // 自有 BYOK 渠道始终可见；平台渠道按生效分组隔离（无分组时退回「全部平台渠道」）
    const visibility: Prisma.ChannelWhereInput = groupCond
      ? { OR: [{ ownerType: ChannelOwnerType.USER, ownerUserId: userId }, groupCond] }
      : {
          OR: [
            { ownerType: ChannelOwnerType.USER, ownerUserId: userId },
            { ownerType: ChannelOwnerType.PLATFORM },
          ],
        };
    const [rows, catalog] = await Promise.all([
      this.prisma.channelModel.findMany({
        where: {
          modelName: model,
          enabled: true,
          channel: {
            AND: [this.availabilityWhere(this.reenableCutoff()), visibility],
          },
        },
        include: { channel: true },
      }),
      this.prisma.modelCatalog.findUnique({
        where: { name: model },
        select: { inputPrice: true },
      }),
    ]);
    const officialIn = catalog ? Number(catalog.inputPrice) : 0;

    const candidates: Candidate[] = [];
    const recoveries: Promise<void>[] = [];
    for (const cm of rows) {
      let apiKey: string;
      try {
        apiKey = this.crypto.decrypt(cm.channel.apiKeyEnc);
      } catch {
        continue; // 解密失败的渠道跳过
      }
      if (!apiKey) continue;
      if (cm.channel.status !== ChannelStatus.ENABLED) {
        recoveries.push(this.recoverChannel(cm.channel));
      }
      // 路由成本 = 绝对成本 > 官方价 × 上游折扣；无有效成本则排最后
      const rawCost =
        cm.costInput != null
          ? Number(cm.costInput)
          : officialIn * (cm.costDiscount != null ? Number(cm.costDiscount) : 1);
      candidates.push({
        id: cm.channel.id,
        c: { channel: cm.channel, apiKey, upstreamModelName: cm.upstreamModelName },
        tier: cm.channel.ownerType === ChannelOwnerType.USER ? 0 : 1,
        priority: cm.priority ?? cm.channel.priority,
        cost: rawCost > 0 ? rawCost : Number.POSITIVE_INFINITY,
        weight: Math.max(cm.weight ?? cm.channel.weight, 1),
        qualityScore: Number(cm.qualityScore ?? 1) || 1,
      });
    }
    if (recoveries.length) await Promise.all(recoveries);
    if (!candidates.length) return [];

    const metricsMap = await this.metrics.snapshot(
      model,
      candidates.map((c) => c.id),
    );

    // 排除 ①模型级冷却中（近期 429/连续失败）②已达每日限额的渠道；
    // 全部被排除时兜底放行——宁可试探拿上游明确报错，也不直接对用户 502
    const overDailyLimit = (c: Candidate): boolean => {
      const m = metricsMap.get(c.id);
      if (!m) return false;
      const rl = c.c.channel.dailyRequestLimit;
      const tl = c.c.channel.dailyTokenLimit;
      return (!!rl && m.dayReq >= rl) || (!!tl && m.dayTok >= tl);
    };
    let eligible = candidates.filter(
      (c) => !metricsMap.get(c.id)?.open && !overDailyLimit(c),
    );
    if (!eligible.length) eligible = candidates;

    const strategy = opts.strategy ?? this.defaultStrategy;
    const scores = scoreCandidates(
      eligible.map((c) => {
        const m = metricsMap.get(c.id);
        return {
          id: c.id,
          cost: c.cost,
          weight: c.weight,
          qualityScore: c.qualityScore,
          metrics: m,
          penalized: !!m && (m.open || m.halfOpen) || overDailyLimit(c),
        };
      }),
      strategy,
    );

    const ranked = [...eligible].sort(
      (a, b) =>
        a.tier - b.tier ||
        b.priority - a.priority ||
        (scores.get(b.id)?.score ?? 0) - (scores.get(a.id)?.score ?? 0),
    );

    const stickyHit =
      this.stickyEnabled && opts.stickyKey
        ? applySticky(ranked, scores, opts.stickyKey, this.stickyRatio)
        : null;

    if (this.debug) {
      this.logger.log(
        `[route] model=${model} strategy=${strategy} → ` +
          ranked
            .map((c) => {
              const m = metricsMap.get(c.id);
              const flag = m?.open ? '!' : overDailyLimit(c) ? '#' : m?.halfOpen ? '~' : '';
              return `${c.id}${flag}(${(scores.get(c.id)?.score ?? 0).toFixed(3)})`;
            })
            .join(' > ') +
          (stickyHit ? ` | sticky=${stickyHit.id}` : ''),
      );
    }

    return ranked.map((r) => r.c);
  }

  /**
   * 自动禁用渠道的半开恢复：冷却期满后重新放行，
   * 失败计数置为阈值-1（下一次失败即再次禁用），成功则由 recordSuccess 彻底复位。
   */
  private async recoverChannel(channel: Channel): Promise<void> {
    try {
      const r = await this.prisma.channel.updateMany({
        where: { id: channel.id, status: ChannelStatus.DISABLED, autoDisabled: true },
        data: {
          status: ChannelStatus.ENABLED,
          autoDisabled: false,
          failureCount: Math.max(this.failureThreshold - 1, 0),
        },
      });
      if (r.count === 1) {
        this.logger.warn(
          `渠道 "${channel.name}" 自动禁用已满冷却期，半开恢复（阈值 ${this.failureThreshold}，仅允许 1 次失败）`,
        );
      }
    } catch (e) {
      this.logger.warn(`渠道半开恢复失败: ${(e as Error)?.message}`);
    }
  }

  supportsAnyModel(userId: string, model: string): Promise<unknown> {
    return this.prisma.channelModel.findFirst({
      where: {
        modelName: model,
        enabled: true,
        channel: {
          OR: [
            { ownerType: ChannelOwnerType.USER, ownerUserId: userId },
            { ownerType: ChannelOwnerType.PLATFORM },
          ],
          AND: [this.availabilityWhere(this.reenableCutoff())],
        },
      },
    });
  }

  /**
   * 模型别名解析：目录 aliases 命中 → 规范名；`X:latest` → X（X 自身为别名时继续解析）；
   * 无命中原样返回。目录查询失败时降级为仅剥 `:latest` 后缀。
   */
  async resolveAlias(model: string): Promise<string> {
    if (!model) return model;
    const lookup = (name: string) =>
      this.prisma.modelCatalog
        .findFirst({
          where: { OR: [{ name }, { aliases: { has: name } }] },
          select: { name: true },
        })
        .catch(() => null);
    const direct = await lookup(model);
    if (direct) return direct.name;
    if (model.endsWith(':latest')) {
      const base = model.slice(0, -':latest'.length);
      const viaBase = await lookup(base);
      if (viaBase) return viaBase.name;
      return base;
    }
    return model;
  }

  /** 批量取目录元数据（provider / capabilities / aliases），供 /v1/models 输出能力字段 */
  async catalogFor(
    names: string[],
  ): Promise<
    Map<string, { name: string; provider: string; capabilities: string[]; aliases: string[] }>
  > {
    if (!names.length) return new Map();
    const rows = await this.prisma.modelCatalog.findMany({
      where: { name: { in: names } },
      select: { name: true, provider: true, capabilities: true, aliases: true },
    });
    return new Map(rows.map((r) => [r.name, r]));
  }

  /**
   * 白名单 → 规范名集合。空/全无效返回 null（不限制）。
   * 批量查询：`name in entries OR aliases hasSome entries`（1 次 findMany）；
   * 命中目录的条目归一为规范名，未命中的（含 DB 故障降级）原样保留（剥 `:latest`）。
   */
  async allowedModelSet(whitelist: string[]): Promise<Set<string> | null> {
    const entries = (whitelist ?? [])
      .map((m) => (typeof m === 'string' && m.endsWith(':latest') ? m.slice(0, -':latest'.length) : m))
      .map((m) => m.trim())
      .filter(Boolean);
    if (!entries.length) return null;
    const uniq = [...new Set(entries)];
    let rows: { name: string; aliases: string[] }[];
    try {
      rows = await this.prisma.modelCatalog.findMany({
        where: { OR: [{ name: { in: uniq } }, { aliases: { hasSome: uniq } }] },
        select: { name: true, aliases: true },
      });
    } catch {
      rows = []; // 目录查询失败降级为字面比对
    }
    const out = new Set<string>();
    for (const entry of uniq) {
      const row = rows.find((r) => r.name === entry || r.aliases.includes(entry));
      out.add(row ? row.name : entry);
    }
    return out;
  }

  /**
   * Key 模型白名单判定。白名单为空 → true（不限制）。
   * 字面快速路径（剥 `:latest` 后命中）→ 0 查询；否则 resolveAlias 规范名 + 白名单规范集比对。
   * 判定依据：请求名（规范形式）∈ 白名单（规范形式）；两者均可含别名。
   */
  async isModelAllowed(requested: string, whitelist: string[]): Promise<boolean> {
    const set = await this.allowedModelSet(whitelist);
    if (!set) return true; // 无白名单限制
    if (!requested) return true; // 未带 model（如 GET /v1/models）交由控制器/后续校验
    const strip = (m: string) => (m.endsWith(':latest') ? m.slice(0, -':latest'.length) : m);
    if (set.has(strip(requested))) return true; // 字面命中（0 额外查询，已含剥 :latest 的快速路径）
    const canonical = await this.resolveAlias(requested);
    return set.has(strip(canonical));
  }

  /** 汇总用户当前可实际调用的模型（自有+平台启用渠道所支持的模型） */
  async availableModels(userId: string, groupId?: string | null): Promise<string[]> {
    const groupCond = this.groups.channelVisibilityWhere(groupId ?? null);
    const visibility: Prisma.ChannelWhereInput = groupCond
      ? { OR: [{ ownerType: ChannelOwnerType.USER, ownerUserId: userId }, groupCond] }
      : {
          OR: [
            { ownerType: ChannelOwnerType.USER, ownerUserId: userId },
            { ownerType: ChannelOwnerType.PLATFORM },
          ],
        };
    const rows = await this.prisma.channelModel.findMany({
      where: {
        enabled: true,
        channel: {
          AND: [this.availabilityWhere(this.reenableCutoff()), visibility],
        },
      },
      distinct: ['modelName'],
      select: { modelName: true },
    });
    return rows.map((r) => r.modelName).sort();
  }
}
