import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { BillingService } from '../billing/billing.service';
import { truncate } from './content.util';

export interface UsageEntry {
  userId: string;
  apiKeyId: string | null;
  channelId: string | null;
  model: string;
  provider: string | null;
  promptTokens: number;
  completionTokens: number;
  cacheReadTokens?: number;
  cacheWriteTokens?: number;
  totalTokens: number;
  latencyMs: number;
  status: number;
  errorMessage?: string | null;
  /** 是否从用户余额扣费（平台渠道为 true，BYOK 为 false） */
  chargeable?: boolean;
  isStream?: boolean;
  /** 输入文本（messages 拍平），受 LOG_CONTENT 开关控制 */
  requestPreview?: string | null;
  /** 输出文本，受 LOG_CONTENT 开关控制 */
  responsePreview?: string | null;
}

export interface LogQuery {
  page?: number;
  pageSize?: number;
  apiKeyId?: string;
  channelId?: string;
  targetUserId?: string;
  model?: string;
  status?: 'success' | 'error';
  stream?: boolean;
  q?: string;
  from?: string;
  to?: string;
}

function utcDay(d = new Date()): Date {
  return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()));
}

function round6(n: number): number {
  return Math.round(n * 1e6) / 1e6;
}

@Injectable()
export class UsageService {
  private readonly logger = new Logger(UsageService.name);
  private readonly logContent: boolean;
  private readonly maxChars: number;

  constructor(
    private readonly prisma: PrismaService,
    private readonly billing: BillingService,
    config: ConfigService,
  ) {
    this.logContent = config.get<string>('LOG_CONTENT', 'false') !== 'false';
    this.maxChars = Number(config.get<string>('LOG_CONTENT_MAX', '20000')) || 20000;
  }

  /** 按渠道×模型定价计算费用；售价再乘用户/代理倍率（相对渠道价）。含缓存读写。 */
  async computeCosts(
    channelId: string | null,
    model: string,
    promptTokens: number,
    completionTokens: number,
    userId?: string,
    cacheReadTokens = 0,
    cacheWriteTokens = 0,
  ): Promise<{ cost: number; upstreamCost: number }> {
    const pricing = await this.billing.getChannelPricing(channelId, model);
    const multiplier = userId ? await this.billing.getUserMultiplier(userId) : 1;
    const nonCached = Math.max(0, promptTokens - cacheReadTokens);
    const cost = round6(
      ((nonCached / 1_000_000) * pricing.priceInput +
        (completionTokens / 1_000_000) * pricing.priceOutput +
        (cacheReadTokens / 1_000_000) * pricing.cacheReadPrice +
        (cacheWriteTokens / 1_000_000) * pricing.cacheWritePrice) *
        multiplier,
    );
    const upstreamCost = round6(
      (nonCached / 1_000_000) * pricing.costInput +
        (completionTokens / 1_000_000) * pricing.costOutput +
        (cacheReadTokens / 1_000_000) * pricing.cacheReadCost +
        (cacheWriteTokens / 1_000_000) * pricing.cacheWriteCost,
    );
    return { cost, upstreamCost };
  }

  /** 记录一次调用：写明细、累计 key 用量、按天聚合。 */
  async record(entry: UsageEntry): Promise<void> {
    const { cost, upstreamCost } = await this.computeCosts(
      entry.channelId,
      entry.model,
      entry.promptTokens,
      entry.completionTokens,
      entry.userId,
      entry.cacheReadTokens ?? 0,
      entry.cacheWriteTokens ?? 0,
    );
    const date = utcDay();

    try {
      await this.prisma.$transaction(async (tx) => {
        const log = await tx.requestLog.create({
          data: {
            userId: entry.userId,
            apiKeyId: entry.apiKeyId,
            channelId: entry.channelId,
            model: entry.model,
            provider: entry.provider,
            promptTokens: entry.promptTokens,
            completionTokens: entry.completionTokens,
            cacheReadTokens: entry.cacheReadTokens ?? 0,
            cacheWriteTokens: entry.cacheWriteTokens ?? 0,
            totalTokens: entry.totalTokens,
            cost,
            upstreamCost,
            chargeable: entry.chargeable === true,
            latencyMs: entry.latencyMs,
            status: entry.status,
            errorMessage: entry.errorMessage ?? null,
            isStream: entry.isStream ?? false,
            requestPreview: this.logContent
              ? truncate(entry.requestPreview, this.maxChars)
              : null,
            responsePreview: this.logContent
              ? truncate(entry.responsePreview, this.maxChars)
              : null,
          },
        });

        if (entry.apiKeyId) {
          await tx.apiKey.update({
            where: { id: entry.apiKeyId },
            data: {
              quotaUsed: { increment: entry.totalTokens },
              // 费用额度只被真实扣费消耗；BYOK 调用不占用 costLimit
              costUsed: { increment: entry.chargeable ? cost : 0 },
              lastUsedAt: new Date(),
            },
          });
        }

        if (entry.chargeable && cost > 0) {
          const commission = await this.billing.recordConsumption(
            tx,
            entry.userId,
            cost,
            log.id,
            `调用 ${entry.model}`,
          );
          if (commission > 0) {
            await tx.requestLog.update({
              where: { id: log.id },
              data: { commission },
            });
          }
        }
      });
    } catch (e) {
      // 明细/扣费失败必须可见，避免静默丢失计费
      this.logger.error(
        `用量记录失败 user=${entry.userId} model=${entry.model}: ${(e as Error)?.message}`,
      );
      return;
    }

    // 日聚合单独执行：失败不影响已提交的明细与扣费
    try {
      await this.aggregateDaily(entry, cost, date);
    } catch (e) {
      this.logger.error(
        `用量日聚合失败 user=${entry.userId} date=${date.toISOString().slice(0, 10)}: ${(e as Error)?.message}`,
      );
    }
  }

  /** 按天聚合：先查后写，命中唯一约束时回退为原子自增 */
  private async aggregateDaily(entry: UsageEntry, cost: number, date: Date): Promise<void> {
    const where = { userId: entry.userId, apiKeyId: entry.apiKeyId, date };
    const billed = entry.chargeable ? cost : 0;
    const inc = {
      requests: { increment: 1 },
      promptTokens: { increment: entry.promptTokens },
      completionTokens: { increment: entry.completionTokens },
      totalTokens: { increment: entry.totalTokens },
      cost: { increment: cost },
      billedCost: { increment: billed },
    };

    const existing = await this.prisma.usageDaily.findFirst({ where });
    if (existing) {
      await this.prisma.usageDaily.update({ where: { id: existing.id }, data: inc });
      return;
    }
    try {
      await this.prisma.usageDaily.create({
        data: {
          userId: entry.userId,
          apiKeyId: entry.apiKeyId,
          date,
          requests: 1,
          promptTokens: entry.promptTokens,
          completionTokens: entry.completionTokens,
          totalTokens: entry.totalTokens,
          cost,
          billedCost: billed,
        },
      });
    } catch (e) {
      if (e instanceof Prisma.PrismaClientKnownRequestError && e.code === 'P2002') {
        await this.prisma.usageDaily.updateMany({ where, data: inc });
        return;
      }
      throw e;
    }
  }

  private scope(userId: string | null): Prisma.RequestLogWhereInput {
    return userId ? { userId } : {};
  }

  /** 按当前筛选导出调用明细 CSV（上限 5 万行）。 */
  async exportLogs(userId: string | null, q: LogQuery = {}): Promise<string> {
    const where = this.buildLogWhere(userId, q);
    const rows = await this.prisma.requestLog.findMany({
      where,
      orderBy: { createdAt: 'desc' },
      take: 50000,
      select: {
        createdAt: true,
        model: true,
        provider: true,
        isStream: true,
        promptTokens: true,
        completionTokens: true,
        totalTokens: true,
        cost: true,
        chargeable: true,
        commission: true,
        latencyMs: true,
        status: true,
        errorMessage: true,
        apiKey: { select: { name: true } },
        channel: { select: { name: true } },
      },
    });

    const esc = (v: unknown): string => {
      const s = v == null ? '' : String(v);
      return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
    };
    const header = [
      '时间',
      '模型',
      '服务商',
      '渠道',
      'Key',
      '流式',
      '输入tokens',
      '输出tokens',
      '总tokens',
      '折算费用(USD)',
      '实际扣费(USD)',
      '返点(USD)',
      '延迟ms',
      '状态',
      '错误',
    ];
    const lines = [header.join(',')];
    for (const r of rows) {
      lines.push(
        [
          r.createdAt.toISOString(),
          r.model,
          r.provider ?? '',
          r.channel?.name ?? '',
          r.apiKey?.name ?? '',
          r.isStream ? 'stream' : 'non-stream',
          r.promptTokens,
          r.completionTokens,
          r.totalTokens,
          Number(r.cost),
          r.chargeable ? Number(r.cost) : 0,
          Number(r.commission),
          r.latencyMs ?? '',
          r.status,
          r.errorMessage ?? '',
        ]
          .map(esc)
          .join(','),
      );
    }
    return lines.join('\n');
  }

  async summary(userId: string | null, days = 30) {
    const since = new Date(Date.now() - days * 24 * 60 * 60 * 1000);
    const [agg, billed] = await Promise.all([
      this.prisma.requestLog.aggregate({
        where: { ...this.scope(userId), createdAt: { gte: since } },
        _count: { _all: true },
        _sum: {
          promptTokens: true,
          completionTokens: true,
          totalTokens: true,
          cost: true,
        },
      }),
      // 实际扣费部分（BYOK 调用不计入），与余额扣款同口径
      this.prisma.requestLog.aggregate({
        where: { ...this.scope(userId), createdAt: { gte: since }, chargeable: true },
        _sum: { cost: true },
      }),
    ]);
    const successCount = await this.prisma.requestLog.count({
      where: { ...this.scope(userId), createdAt: { gte: since }, status: { lt: 400 } },
    });
    return {
      rangeDays: days,
      requests: agg._count._all,
      successRequests: successCount,
      errorRequests: agg._count._all - successCount,
      promptTokens: agg._sum.promptTokens ?? 0,
      completionTokens: agg._sum.completionTokens ?? 0,
      totalTokens: agg._sum.totalTokens ?? 0,
      cost: agg._sum.cost ?? 0,
      billedCost: billed._sum.cost ?? 0,
    };
  }

  async daily(userId: string | null, days = 30) {
    const since = utcDay(new Date(Date.now() - (days - 1) * 24 * 60 * 60 * 1000));
    const rows = await this.prisma.usageDaily.findMany({
      where: { ...(userId ? { userId } : {}), date: { gte: since } },
      orderBy: { date: 'asc' },
    });
    const byDate = new Map<string, any>();
    for (const r of rows) {
      const key = r.date.toISOString().slice(0, 10);
      const agg = byDate.get(key) ?? {
        date: key,
        requests: 0,
        promptTokens: 0,
        completionTokens: 0,
        totalTokens: 0,
        cost: 0,
        billedCost: 0,
      };
      agg.requests += r.requests;
      agg.promptTokens += r.promptTokens;
      agg.completionTokens += r.completionTokens;
      agg.totalTokens += r.totalTokens;
      agg.cost += Number(r.cost);
      agg.billedCost += Number(r.billedCost);
      byDate.set(key, agg);
    }
    return [...byDate.values()];
  }

  async logs(userId: string | null, q: LogQuery = {}) {
    const page = q.page && q.page > 0 ? q.page : 1;
    const pageSize = q.pageSize && q.pageSize > 0 ? Math.min(q.pageSize, 100) : 20;
    const where = this.buildLogWhere(userId, q);
    const [items, total] = await Promise.all([
      this.prisma.requestLog.findMany({
        where,
        orderBy: { createdAt: 'desc' },
        skip: (page - 1) * pageSize,
        take: pageSize,
        select: {
          id: true,
          userId: true,
          model: true,
          provider: true,
          isStream: true,
          promptTokens: true,
          completionTokens: true,
          totalTokens: true,
          cost: true,
          chargeable: true,
          latencyMs: true,
          status: true,
          errorMessage: true,
          createdAt: true,
          apiKey: { select: { name: true, keyPrefix: true } },
          channel: { select: { name: true, provider: true } },
        },
      }),
      this.prisma.requestLog.count({ where }),
    ]);
    return { items, total, page, pageSize };
  }

  private buildLogWhere(userId: string | null, q: LogQuery): Prisma.RequestLogWhereInput {
    const where: Prisma.RequestLogWhereInput = {
      ...this.scope(userId),
      ...(q.apiKeyId ? { apiKeyId: q.apiKeyId } : {}),
      ...(q.channelId ? { channelId: q.channelId } : {}),
      // 仅当调用方没有属主约束（管理员 scope=all / 指定 userId 由 controller 解析）时，
      // 才允许按 userId 过滤；否则由本方法覆盖属主条件会造成跨租户越权。
      ...(userId === null && q.targetUserId ? { userId: q.targetUserId } : {}),
      ...(q.model ? { model: { contains: q.model, mode: 'insensitive' } } : {}),
      ...(q.stream !== undefined ? { isStream: q.stream } : {}),
    };
    if (q.status === 'success') where.status = { lt: 400 };
    else if (q.status === 'error') where.status = { gte: 400 };

    if (q.from || q.to) {
      where.createdAt = {
        ...(q.from ? { gte: new Date(q.from) } : {}),
        ...(q.to ? { lte: new Date(q.to) } : {}),
      };
    }
    if (q.q) {
      where.OR = [
        { requestPreview: { contains: q.q, mode: 'insensitive' } },
        { responsePreview: { contains: q.q, mode: 'insensitive' } },
        { errorMessage: { contains: q.q, mode: 'insensitive' } },
      ];
    }
    return where;
  }

  /** 使用分析：按模型/渠道/用户/Key 聚合；支持 days 或显式 from/to 时间段。 */
  async analytics(
    userId: string | null,
    days = 30,
    range?: { from?: string; to?: string },
  ) {
    const since = range?.from
      ? new Date(range.from)
      : new Date(Date.now() - days * 24 * 60 * 60 * 1000);
    const until = range?.to ? new Date(range.to) : undefined;
    const created: Prisma.DateTimeFilter = {
      gte: since,
      ...(until ? { lte: until } : {}),
    };
    const base: Prisma.RequestLogWhereInput = { ...this.scope(userId), createdAt: created };

    const [
      byModel,
      byModelErr,
      byChannel,
      byChannelErr,
      byUser,
      byApiKey,
      totals,
      totalErr,
    ] = await Promise.all([
      this.prisma.requestLog.groupBy({
        by: ['model'],
        where: base,
        _count: { _all: true },
        _sum: { totalTokens: true, cost: true, upstreamCost: true },
      }),
      this.prisma.requestLog.groupBy({
        by: ['model'],
        where: { ...base, status: { gte: 400 } },
        _count: { _all: true },
      }),
      this.prisma.requestLog.groupBy({
        by: ['channelId'],
        where: base,
        _count: { _all: true },
        _sum: { totalTokens: true, cost: true, upstreamCost: true },
        _avg: { latencyMs: true },
      }),
      this.prisma.requestLog.groupBy({
        by: ['channelId'],
        where: { ...base, status: { gte: 400 } },
        _count: { _all: true },
      }),
        userId
          ? Promise.resolve([] as any[])
          : this.prisma.requestLog.groupBy({
              by: ['userId'],
              where: base,
              _count: { _all: true },
              _sum: { totalTokens: true, cost: true, upstreamCost: true },
            }),
        this.prisma.requestLog.groupBy({
          by: ['apiKeyId'],
          where: base,
          _count: { _all: true },
          _sum: { totalTokens: true, cost: true, upstreamCost: true },
        }),
        this.prisma.requestLog.aggregate({
          where: base,
          _count: { _all: true },
          _sum: { totalTokens: true, cost: true, upstreamCost: true },
        }),
        this.prisma.requestLog.count({ where: { ...base, status: { gte: 400 } } }),
      ]);

    const errByModel = new Map(byModelErr.map((r) => [r.model, r._count._all]));
    const errByChannel = new Map(
      byChannelErr.map((r) => [r.channelId, r._count._all]),
    );

    // 实际扣费部分：同维度再聚合一次（仅 chargeable 的调用），用于「费用(已扣)」口径
    const billedBase: Prisma.RequestLogWhereInput = { ...base, chargeable: true };
    const billedAgg = { cost: true, upstreamCost: true } as const;
    const [billedByModel, billedByChannel, billedByUser, billedByApiKey, billedTotals] =
      await Promise.all([
        this.prisma.requestLog.groupBy({
          by: ['model'],
          where: billedBase,
          _sum: billedAgg,
        }),
        this.prisma.requestLog.groupBy({
          by: ['channelId'],
          where: billedBase,
          _sum: billedAgg,
        }),
        userId
          ? Promise.resolve([] as any[])
          : this.prisma.requestLog.groupBy({
              by: ['userId'],
              where: billedBase,
              _sum: billedAgg,
            }),
        this.prisma.requestLog.groupBy({
          by: ['apiKeyId'],
          where: billedBase,
          _sum: billedAgg,
        }),
        this.prisma.requestLog.aggregate({
          where: billedBase,
          _sum: billedAgg,
        }),
      ]);

    /** 平台口径：实收（billedCost）与实付上游成本（billedUpstreamCost），BYOK 两者皆为 0 */
    const billedMap = (rows: any[], key: string) =>
      new Map(
        rows.map((r) => [
          r[key],
          {
            cost: Number(r._sum?.cost ?? 0),
            upstreamCost: Number(r._sum?.upstreamCost ?? 0),
          },
        ]),
      );
    const billedModel = billedMap(billedByModel, 'model');
    const billedChannel = billedMap(billedByChannel, 'channelId');
    const billedUser = billedMap(billedByUser, 'userId');
    const billedApiKey = billedMap(billedByApiKey, 'apiKeyId');

    // 渠道/用户/Key 名称
    const channelIds = byChannel.map((c) => c.channelId).filter(Boolean) as string[];
    const userIds = byUser.map((u) => u.userId).filter(Boolean) as string[];
    const apiKeyIds = byApiKey.map((k) => k.apiKeyId).filter(Boolean) as string[];
    const [channels, users, apiKeys] = await Promise.all([
      channelIds.length
        ? this.prisma.channel.findMany({
            where: { id: { in: channelIds } },
            select: { id: true, name: true, provider: true },
          })
        : Promise.resolve([] as any[]),
      userIds.length
        ? this.prisma.user.findMany({
            where: { id: { in: userIds } },
            select: { id: true, username: true, email: true },
          })
        : Promise.resolve([] as any[]),
      apiKeyIds.length
        ? this.prisma.apiKey.findMany({
            where: { id: { in: apiKeyIds } },
            select: { id: true, name: true, keyPrefix: true },
          })
        : Promise.resolve([] as any[]),
    ]);
    const chMap = new Map(channels.map((c: any) => [c.id, c]));
    const uMap = new Map(users.map((u: any) => [u.id, u]));
    const kMap = new Map(apiKeys.map((k: any) => [k.id, k]));

    const mapAgg = (r: any, billed?: { cost: number; upstreamCost: number }) => {
      const revenue = Number(r._sum?.cost ?? 0);
      const upstreamCost = Number(r._sum?.upstreamCost ?? 0);
      const billedCost = billed?.cost ?? 0;
      return {
        requests: r._count._all,
        tokens: r._sum?.totalTokens ?? 0,
        cost: revenue,
        billedCost,
        upstreamCost,
        billedUpstreamCost: billed?.upstreamCost ?? 0,
        // 毛利按平台实收 - 平台实付：BYOK 两条腿都是 0，不产生幻影毛利
        margin: billedCost - (billed?.upstreamCost ?? 0),
      };
    };

    return {
      rangeDays: days,
      from: since.toISOString(),
      to: (until ?? new Date()).toISOString(),
      totals: {
        requests: totals._count._all,
        errors: totalErr,
        success: totals._count._all - totalErr,
        tokens: totals._sum.totalTokens ?? 0,
        cost: Number(totals._sum.cost ?? 0),
        billedCost: Number(billedTotals._sum.cost ?? 0),
        upstreamCost: Number(totals._sum.upstreamCost ?? 0),
        billedUpstreamCost: Number(billedTotals._sum.upstreamCost ?? 0),
        margin:
          Number(billedTotals._sum.cost ?? 0) -
          Number(billedTotals._sum.upstreamCost ?? 0),
      },
      byModel: byModel
        .map((r) => ({
          model: r.model,
          ...mapAgg(r, billedModel.get(r.model)),
          errors: errByModel.get(r.model) ?? 0,
        }))
        .sort((a, b) => b.tokens - a.tokens)
        .slice(0, 20),
      byChannel: byChannel
        .map((r) => ({
          channelId: r.channelId,
          name: chMap.get(r.channelId ?? '')?.name ?? '(已删除)',
          provider: chMap.get(r.channelId ?? '')?.provider ?? '',
          ...mapAgg(r, billedChannel.get(r.channelId)),
          // 渠道健康度视角：错误数与平均耗时（对应智能路由的稳定性/延迟维度）
          errors: errByChannel.get(r.channelId) ?? 0,
          avgLatency: Math.round(r._avg?.latencyMs ?? 0),
        }))
        .sort((a, b) => b.tokens - a.tokens)
        .slice(0, 20),
      byUser: byUser
        .map((r) => ({
          userId: r.userId,
          name: uMap.get(r.userId)?.username ?? '(已删除)',
          ...mapAgg(r, billedUser.get(r.userId)),
        }))
        .sort((a, b) => b.tokens - a.tokens)
        .slice(0, 20),
      byApiKey: byApiKey
        .map((r) => ({
          apiKeyId: r.apiKeyId,
          name: kMap.get(r.apiKeyId ?? '')?.name ?? '(已删除)',
          keyPrefix: kMap.get(r.apiKeyId ?? '')?.keyPrefix ?? '',
          ...mapAgg(r, billedApiKey.get(r.apiKeyId)),
        }))
        .sort((a, b) => b.tokens - a.tokens)
        .slice(0, 50),
    };
  }

  /** 单条日志详情（含输入/输出内容），普通用户仅能看自己的。 */
  async detail(userId: string | null, id: string) {
    return this.prisma.requestLog.findFirst({
      where: { id, ...(userId ? { userId } : {}) },
      include: {
        apiKey: { select: { name: true, keyPrefix: true } },
        channel: { select: { name: true, provider: true } },
      },
    });
  }
}
