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
    this.logContent = config.get<string>('LOG_CONTENT', 'true') !== 'false';
    this.maxChars = Number(config.get<string>('LOG_CONTENT_MAX', '20000')) || 20000;
  }

  /** 按渠道×模型定价计算向用户收取的费用与上游成本。 */
  async computeCosts(
    channelId: string | null,
    model: string,
    promptTokens: number,
    completionTokens: number,
  ): Promise<{ cost: number; upstreamCost: number }> {
    const pricing = await this.billing.getChannelPricing(channelId, model);
    const cost = round6(
      (promptTokens / 1_000_000) * pricing.priceInput +
        (completionTokens / 1_000_000) * pricing.priceOutput,
    );
    const upstreamCost = round6(
      (promptTokens / 1_000_000) * pricing.costInput +
        (completionTokens / 1_000_000) * pricing.costOutput,
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
            totalTokens: entry.totalTokens,
            cost,
            upstreamCost,
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
              costUsed: { increment: cost },
              lastUsedAt: new Date(),
            },
          });
        }

        if (entry.chargeable && cost > 0) {
          await this.billing.recordConsumption(
            tx,
            entry.userId,
            cost,
            log.id,
            `调用 ${entry.model}`,
          );
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
    const inc = {
      requests: { increment: 1 },
      promptTokens: { increment: entry.promptTokens },
      completionTokens: { increment: entry.completionTokens },
      totalTokens: { increment: entry.totalTokens },
      cost: { increment: cost },
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

  async summary(userId: string | null, days = 30) {
    const since = new Date(Date.now() - days * 24 * 60 * 60 * 1000);
    const agg = await this.prisma.requestLog.aggregate({
      where: { ...this.scope(userId), createdAt: { gte: since } },
      _count: { _all: true },
      _sum: {
        promptTokens: true,
        completionTokens: true,
        totalTokens: true,
        cost: true,
      },
    });
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
      };
      agg.requests += r.requests;
      agg.promptTokens += r.promptTokens;
      agg.completionTokens += r.completionTokens;
      agg.totalTokens += r.totalTokens;
      agg.cost += Number(r.cost);
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
      ...(q.targetUserId ? { userId: q.targetUserId } : {}),
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

  /** 使用分析：按模型/渠道/用户聚合。 */
  async analytics(userId: string | null, days = 30) {
    const since = new Date(Date.now() - days * 24 * 60 * 60 * 1000);
    const base: Prisma.RequestLogWhereInput = { ...this.scope(userId), createdAt: { gte: since } };

    const [byModel, byModelErr, byChannel, byUser, totals, totalErr] = await Promise.all([
      this.prisma.requestLog.groupBy({
        by: ['model'],
        where: base,
        _count: { _all: true },
        _sum: { totalTokens: true, cost: true },
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
        _sum: { totalTokens: true, cost: true },
      }),
      userId
        ? Promise.resolve([] as any[])
        : this.prisma.requestLog.groupBy({
            by: ['userId'],
            where: base,
            _count: { _all: true },
            _sum: { totalTokens: true, cost: true },
          }),
      this.prisma.requestLog.aggregate({
        where: base,
        _count: { _all: true },
        _sum: { totalTokens: true, cost: true },
      }),
      this.prisma.requestLog.count({ where: { ...base, status: { gte: 400 } } }),
    ]);

    const errByModel = new Map(byModelErr.map((r) => [r.model, r._count._all]));

    // 渠道/用户名称
    const channelIds = byChannel.map((c) => c.channelId).filter(Boolean) as string[];
    const userIds = byUser.map((u) => u.userId).filter(Boolean) as string[];
    const channels = channelIds.length
      ? await this.prisma.channel.findMany({
          where: { id: { in: channelIds } },
          select: { id: true, name: true, provider: true },
        })
      : [];
    const users = userIds.length
      ? await this.prisma.user.findMany({
          where: { id: { in: userIds } },
          select: { id: true, username: true, email: true },
        })
      : [];
    const chMap = new Map(channels.map((c) => [c.id, c]));
    const uMap = new Map(users.map((u) => [u.id, u]));

    const mapAgg = (r: any) => ({
      requests: r._count._all,
      tokens: r._sum?.totalTokens ?? 0,
      cost: Number(r._sum?.cost ?? 0),
    });

    return {
      rangeDays: days,
      totals: {
        requests: totals._count._all,
        errors: totalErr,
        success: totals._count._all - totalErr,
        tokens: totals._sum.totalTokens ?? 0,
        cost: Number(totals._sum.cost ?? 0),
      },
      byModel: byModel
        .map((r) => ({
          model: r.model,
          ...mapAgg(r),
          errors: errByModel.get(r.model) ?? 0,
        }))
        .sort((a, b) => b.tokens - a.tokens)
        .slice(0, 20),
      byChannel: byChannel
        .map((r) => ({
          channelId: r.channelId,
          name: chMap.get(r.channelId ?? '')?.name ?? '(已删除)',
          provider: chMap.get(r.channelId ?? '')?.provider ?? '',
          ...mapAgg(r),
        }))
        .sort((a, b) => b.tokens - a.tokens)
        .slice(0, 20),
      byUser: byUser
        .map((r) => ({
          userId: r.userId,
          name: uMap.get(r.userId)?.username ?? '(已删除)',
          ...mapAgg(r),
        }))
        .sort((a, b) => b.tokens - a.tokens)
        .slice(0, 20),
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
