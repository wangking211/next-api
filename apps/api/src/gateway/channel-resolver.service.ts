import { Injectable, Logger, Optional } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import {
  Channel,
  ChannelOwnerType,
  ChannelStatus,
  ModelCatalog,
  Prisma,
  RoutingStrategy,
} from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { CryptoService } from '../common/crypto.service';
import { TtlCacheService } from '../common/ttl-cache.service';
import { assertChannelUrlSafe } from '../common/url-safety';
import { ResolvedChannel } from './types';
import { RoutingMetricsService } from './routing-metrics.service';
import { GroupsService } from '../groups/groups.service';
import {
  CatalogPricingRow,
  ChannelModelPricingRow,
  deriveChannelPricing,
} from '../billing/pricing.util';
import { shareExhausted, shareUrgencyBonus } from './channel-share.util';
import { DEFAULT_STRATEGY, applySticky, isRoutingStrategy, scoreCandidates } from './routing-score';

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
  private readonly catalogTtl: number;

  constructor(
    private readonly prisma: PrismaService,
    private readonly crypto: CryptoService,
    private readonly metrics: RoutingMetricsService,
    private readonly groups: GroupsService,
    config: ConfigService,
    // 测试里手工构造时未传缓存 → 退回直查（行为不变）
    @Optional() private readonly cache?: TtlCacheService,
  ) {
    const s = config.get<string>('ROUTING_STRATEGY', DEFAULT_STRATEGY);
    this.defaultStrategy = isRoutingStrategy(s) ? s : DEFAULT_STRATEGY;
    this.stickyEnabled = config.get<string>('ROUTING_STICKY', 'true') !== 'false';
    const r = Number(config.get<string>('ROUTING_STICKY_RATIO', '0.8'));
    this.stickyRatio = Number.isFinite(r) && r > 0 && r <= 1 ? r : 0.8;
    this.autoReenableMs =
      Number(config.get<string>('CHANNEL_AUTO_REENABLE_MS', '900000')) || 900000;
    this.failureThreshold = Number(config.get<string>('CHANNEL_FAILURE_THRESHOLD', '5')) || 5;
    this.debug = config.get<string>('ROUTING_DEBUG') === 'true';
    this.catalogTtl = Number(config.get<string>('CATALOG_CACHE_TTL_MS', '60000')) || 60_000;
  }

  /**
   * 模型目录全表快照（默认 60s TTL，写路径在 models.service 失效）。
   * 热路径的别名解析 / 白名单 / 元数据 / 官方价全部走这份内存副本。
   * 未注入缓存（测试）时返回 null，调用方回退直查。
   */
  private async catalogRows(): Promise<ModelCatalog[] | null> {
    if (!this.cache) return null;
    return this.cache.getOrLoad<ModelCatalog[]>('catalog:all', this.catalogTtl, () =>
      this.prisma.modelCatalog.findMany(),
    );
  }

  /** 单行目录（带缓存）：热路径定价派生用；未注入缓存时退回单行直查 */
  private async catalogRow(model: string): Promise<ModelCatalog | null> {
    const rows = await this.catalogRows();
    if (rows) return rows.find((r) => r.name === model) ?? null;
    return this.prisma.modelCatalog.findUnique({ where: { name: model } }).catch(() => null);
  }

  /** 目录行按名/别名匹配（内存副本）：精确名优先，其次别名；均未命中返回 null */
  private static matchByName(rows: ModelCatalog[], name: string): ModelCatalog | null {
    return rows.find((r) => r.name === name) ?? rows.find((r) => r.aliases.includes(name)) ?? null;
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
    // 渠道可见性（含共享渠道）：自有 BYOK / 他人公开共享 / 他人同分组共享 / 平台渠道按分组。
    // ⚠️ 共享与分组条件都必须显式限定 ownerType，否则会把别人的私有渠道暴露出去。
    const visibility: Prisma.ChannelWhereInput = this.groups.channelScopeWhere(
      userId,
      opts.groupId ?? null,
    );
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
      this.catalogRow(model),
    ]);
    // 目录里被停用的模型不路由（与可用模型列表同口径）；
    // 只在显式 false 时拦截，避免部分字段的目录行（未 select enabled）被误判
    if (catalog && catalog.enabled === false) return [];
    const officialIn = catalog?.inputPrice != null ? Number(catalog.inputPrice) : 0;

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
      // 共享渠道的额度/到期闸门：达到上限或已到期就不再派发（渠道主「烧额度」诉求）
      // 渠道主本人豁免：自己的调用不吃共享额度，否则额度烧尽会掐断 tier-0 自路由
      if (this.shareExhausted(cm.channel, userId)) continue;
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
        c: {
          channel: cm.channel,
          apiKey,
          upstreamModelName: cm.upstreamModelName,
          // 本地派生定价：预授权/落账直接复用，热路径免再查渠道×模型价与目录价
          pricing: deriveChannelPricing(
            cm as unknown as ChannelModelPricingRow,
            catalog as CatalogPricingRow | null,
          ),
        },
        tier:
          cm.channel.ownerType === ChannelOwnerType.USER && cm.channel.ownerUserId === userId
            ? 0
            : 1,
        priority:
          (cm.priority ?? cm.channel.priority) +
          this.shareUrgencyBonus(cm.channel, cm.qualityScore),
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
    let eligible = candidates.filter((c) => !metricsMap.get(c.id)?.open && !overDailyLimit(c));
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
          penalized: (!!m && (m.open || m.halfOpen)) || overDailyLimit(c),
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

    // SSRF 请求时复验：域名可能在保存后被改解析（DNS rebinding —— 保存时是公网、
    // 请求时解析到内网/云元数据），不安全的渠道从候选剔除（按 scheme://host 60s
    // 缓存，热路径近零成本）；全部不安全 → 空候选，上层按「无可用渠道」处理
    const checked = await Promise.all(
      ranked.map(async (r) => {
        try {
          await assertChannelUrlSafe(r.c.channel.baseUrl);
          return r;
        } catch (e) {
          this.logger.warn(
            `渠道 "${r.c.channel.name}" baseUrl 请求时复验失败，已跳过路由: ${(e as Error)?.message}`,
          );
          return null;
        }
      }),
    );
    return checked.filter((r): r is (typeof ranked)[number] => r !== null).map((r) => r.c);
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

  /**
   * 模型别名解析：目录 aliases 命中 → 规范名；`X:latest` → X（X 自身为别名时继续解析）；
   * 无命中原样返回。目录查询失败时降级为仅剥 `:latest` 后缀。
   * 命中内存快照时 0 查询；未注入缓存时保持原有的逐次 findFirst。
   */
  async resolveAlias(model: string): Promise<string> {
    if (!model) return model;
    const rows = await this.catalogRows();
    const lookup = rows
      ? (name: string) => Promise.resolve(ChannelResolverService.matchByName(rows, name))
      : (name: string) =>
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
    const rows = await this.catalogRows();
    if (rows) {
      const want = new Set(names);
      return new Map(rows.filter((r) => want.has(r.name)).map((r) => [r.name, r]));
    }
    const direct = await this.prisma.modelCatalog.findMany({
      where: { name: { in: names } },
      select: { name: true, provider: true, capabilities: true, aliases: true },
    });
    return new Map(direct.map((r) => [r.name, r]));
  }

  /**
   * 目录里标了 `video` 能力的模型名。
   * 用于视频任务在进程内映射缺失时（发布重启/多副本）反查可能建过该任务的渠道。
   */
  async videoModelNames(): Promise<string[]> {
    const rows = await this.catalogRows();
    if (rows) {
      return rows.filter((r) => r.capabilities.includes('video')).map((r) => r.name);
    }
    const direct = await this.prisma.modelCatalog.findMany({
      where: { capabilities: { has: 'video' } },
      select: { name: true },
    });
    return direct.map((r) => r.name);
  }

  /**
   * 白名单 → 规范名集合。空/全无效返回 null（不限制）。
   * 批量查询：`name in entries OR aliases hasSome entries`（1 次 findMany，或内存快照 0 查询）；
   * 命中目录的条目归一为规范名，未命中的（含 DB 故障降级）原样保留（剥 `:latest`）。
   */
  async allowedModelSet(whitelist: string[]): Promise<Set<string> | null> {
    const entries = (whitelist ?? [])
      .map((m) =>
        typeof m === 'string' && m.endsWith(':latest') ? m.slice(0, -':latest'.length) : m,
      )
      .map((m) => m.trim())
      .filter(Boolean);
    if (!entries.length) return null;
    const uniq = [...new Set(entries)];
    let rows: { name: string; aliases: string[] }[];
    try {
      const snapshot = await this.catalogRows();
      if (snapshot) {
        const want = new Set(uniq);
        rows = snapshot
          .filter((r) => want.has(r.name) || r.aliases.some((a) => want.has(a)))
          .map((r) => ({ name: r.name, aliases: r.aliases }));
      } else {
        rows = await this.prisma.modelCatalog.findMany({
          where: { OR: [{ name: { in: uniq } }, { aliases: { hasSome: uniq } }] },
          select: { name: true, aliases: true },
        });
      }
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

  /** 汇总用户当前可实际调用的模型（自有+共享+平台启用渠道所支持的模型） */
  async availableModels(userId: string, groupId?: string | null): Promise<string[]> {
    const visibility = this.groups.channelScopeWhere(userId, groupId ?? null);
    const rows = await this.prisma.channelModel.findMany({
      where: {
        enabled: true,
        channel: {
          AND: [this.availabilityWhere(this.reenableCutoff()), visibility],
        },
      },
      select: { modelName: true, channel: true },
    });
    const names = [
      ...new Set(
        rows.filter((r) => !this.shareExhausted(r.channel, userId)).map((r) => r.modelName),
      ),
    ].sort();
    return this.filterCatalogEnabled(names);
  }

  /**
   * 共享渠道是否已「用尽」（额度/到期）——实现见 channel-share.util。
   * `callerId` 为渠道主时豁免（自己的调用不吃共享额度）。
   */
  private shareExhausted(
    channel?: Channel | null,
    callerId?: string | null,
    now = Date.now(),
  ): boolean {
    return shareExhausted(channel, now, callerId);
  }

  /** 共享紧急度 → 优先级加成——实现见 channel-share.util */
  private shareUrgencyBonus(channel: Channel, qualityScore: unknown): number {
    return shareUrgencyBonus(channel, qualityScore);
  }

  /**
   * 目录里存在但被停用的模型一律不对外（`ModelCatalog.enabled=false`）。
   * 让「模型」页的启用/停用开关真正生效（此前只影响落地页展示）。
   * 目录里没有的模型放行——不隐性屏蔽历史数据/手工加的渠道模型。
   */
  private async filterCatalogEnabled(names: string[]): Promise<string[]> {
    if (!names.length) return names;
    const rows = await this.catalogRows();
    if (rows) {
      const off = new Set(rows.filter((r) => r.enabled === false).map((r) => r.name));
      return names.filter((n) => !off.has(n));
    }
    const disabled = await this.prisma.modelCatalog.findMany({
      where: { name: { in: names }, enabled: false },
      select: { name: true },
    });
    const off = new Set(disabled.map((r) => r.name));
    return names.filter((n) => !off.has(n));
  }
}
