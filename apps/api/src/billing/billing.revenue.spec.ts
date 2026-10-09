import { BadRequestException } from '@nestjs/common';
import { BillingService } from './billing.service';
import { PrismaService } from '../prisma/prisma.service';

/**
 * BillingService.getRevenue（「我的收益」汇总）：
 * - total 走账本（BalanceTransaction CHANNEL_REVENUE 累计，Decimal → number）；带区间时按 gte/lte 过滤
 * - thisMonth 独立口径：当前 UTC+8 自然月起点至今
 * - months 走原始 SQL（UTC+8 归月），缺省近 12 月窗口，区间模式传起止
 * - channels 缺省走 Channel.shareRevenue（O(1) 列）+ RequestLog groupBy 补调用统计；
 *   区间模式改按区间日志分成聚合，只列区间内有收益的渠道
 */
function makePrisma() {
  return {
    balanceTransaction: {
      aggregate: jest.fn().mockResolvedValue({ _sum: { amount: '12.5' } }),
    },
    $queryRaw: jest.fn().mockResolvedValue([
      { month: '2026-09', revenue: 3.5 },
      { month: '2026-10', revenue: 1.25 },
    ]),
    channel: {
      findMany: jest.fn().mockResolvedValue([
        {
          id: 'c1',
          name: 'shared-a',
          shareMode: 'PUBLIC',
          status: 'ENABLED',
          shareRevenue: '4.1',
        },
        {
          id: 'c2',
          name: 'shared-b',
          shareMode: 'GROUP',
          status: 'DISABLED',
          shareRevenue: '0',
        },
      ]),
    },
    requestLog: {
      groupBy: jest.fn().mockResolvedValue([
        {
          channelId: 'c1',
          _count: 7,
          _sum: { channelRevenue: '2.5' },
          _max: { createdAt: new Date('2026-10-01T02:03:04Z') },
        },
      ]),
    },
  };
}

function makeService(prisma = makePrisma()) {
  const service = new BillingService(prisma as unknown as PrismaService);
  return { service, prisma };
}

describe('BillingService.getRevenue（我的收益汇总）', () => {
  it('total 用账本累计并 Decimal → number，months 原样映射，thisMonth 独立第二条 aggregate', async () => {
    const { service, prisma } = makeService();
    const res = await service.getRevenue('u1');
    expect(res.total).toBe(12.5);
    expect(res.thisMonth).toBe(12.5);
    expect(res.months).toEqual([
      { month: '2026-09', revenue: 3.5 },
      { month: '2026-10', revenue: 1.25 },
    ]);
    expect(prisma.balanceTransaction.aggregate).toHaveBeenNthCalledWith(1, {
      where: { userId: 'u1', type: 'CHANNEL_REVENUE' },
      _sum: { amount: true },
    });
    // 本月 = 当前 UTC+8 自然月 1 日 00:00 起（回加 8 小时后必为 1 日 0 点，且距今 0 个月内）
    const monthWhere = (prisma.balanceTransaction.aggregate as jest.Mock).mock.calls[1][0].where;
    const start = monthWhere.createdAt.gte as Date;
    const local = new Date(start.getTime() + 8 * 3600_000);
    expect(local.getUTCDate()).toBe(1);
    expect(local.getUTCHours()).toBe(0);
    const now8 = new Date(Date.now() + 8 * 3600_000);
    expect(local.getUTCFullYear()).toBe(now8.getUTCFullYear());
    expect(local.getUTCMonth()).toBe(now8.getUTCMonth());
  });

  it('月份原始 SQL 带 userId 与近 12 月窗口起点（UTC+8 月初对应的 UTC 时刻）', async () => {
    const { service, prisma } = makeService();
    await service.getRevenue('u1');
    const args = (prisma.$queryRaw as jest.Mock).mock.calls[0];
    // 标签模板：args[0] 为字符串片段，之后依次是 userId、窗口起点、上界哨兵
    expect(args[1]).toBe('u1');
    const since = args[2] as Date;
    expect(since).toBeInstanceOf(Date);
    // 起点 = UTC+8 某月 1 日 00:00 对应的 UTC 时刻（回加 8 小时后必为 1 日 0 点），距今 11~12 个月
    const local = new Date(since.getTime() + 8 * 3600_000);
    expect(local.getUTCDate()).toBe(1);
    expect(local.getUTCHours()).toBe(0);
    expect(since.getUTCHours()).toBe(16);
    const now8 = new Date(Date.now() + 8 * 3600_000);
    const monthsBack =
      (now8.getUTCFullYear() - local.getUTCFullYear()) * 12 +
      (now8.getUTCMonth() - local.getUTCMonth());
    expect(monthsBack === 11 || monthsBack === 12).toBe(true);
    // 缺省无上界：用远未来哨兵占固定参数位
    expect((args[3] as Date).getUTCFullYear()).toBeGreaterThan(2900);
  });

  it('渠道列表按收益列 Decimal → number，统计行命中则带 calls/lastAt', async () => {
    const { service } = makeService();
    const res = await service.getRevenue('u1');
    expect(res.channels).toEqual([
      {
        id: 'c1',
        name: 'shared-a',
        shareMode: 'PUBLIC',
        status: 'ENABLED',
        revenue: 4.1,
        calls: 7,
        lastAt: new Date('2026-10-01T02:03:04Z'),
      },
      {
        id: 'c2',
        name: 'shared-b',
        shareMode: 'GROUP',
        status: 'DISABLED',
        revenue: 0,
        calls: 0,
        lastAt: null,
      },
    ]);
  });

  it('渠道筛选：仅本人自有渠道，零收益且非共享的渠道不进结果', async () => {
    const { service, prisma } = makeService();
    await service.getRevenue('u1');
    const where = (prisma.channel.findMany as jest.Mock).mock.calls[0][0].where;
    expect(where.ownerType).toBe('USER');
    expect(where.ownerUserId).toBe('u1');
    expect(where.OR).toEqual([{ shareRevenue: { gt: 0 } }, { shareMode: { not: 'PRIVATE' } }]);
  });

  it('无渠道时不查 RequestLog 统计', async () => {
    const prisma = makePrisma();
    prisma.channel.findMany = jest.fn().mockResolvedValue([]);
    const { service } = makeService(prisma);
    const res = await service.getRevenue('u1');
    expect(res.channels).toEqual([]);
    expect(prisma.requestLog.groupBy).not.toHaveBeenCalled();
  });
});

describe('BillingService.getRevenue 时间区间（from/to 查历史收益）', () => {
  const fromIso = '2026-01-01T00:00:00.000Z';
  const toIso = '2026-06-30T15:59:59.999Z';

  it('区间模式：total 按 gte/lte 过滤，months SQL 起止用给定值', async () => {
    const { service, prisma } = makeService();
    await service.getRevenue('u1', { from: fromIso, to: toIso });
    expect(prisma.balanceTransaction.aggregate).toHaveBeenNthCalledWith(1, {
      where: {
        userId: 'u1',
        type: 'CHANNEL_REVENUE',
        createdAt: { gte: new Date(fromIso), lte: new Date(toIso) },
      },
      _sum: { amount: true },
    });
    const args = (prisma.$queryRaw as jest.Mock).mock.calls[0];
    expect(args[2]).toEqual(new Date(fromIso));
    expect(args[3]).toEqual(new Date(toIso));
  });

  it('仅 from（查到现在）：SQL 上界用远未来哨兵，total 只有下界，渠道查询不带 OR 过滤', async () => {
    const { service, prisma } = makeService();
    await service.getRevenue('u1', { from: fromIso });
    const args = (prisma.$queryRaw as jest.Mock).mock.calls[0];
    expect(args[2]).toEqual(new Date(fromIso));
    expect((args[3] as Date).getUTCFullYear()).toBeGreaterThan(2900);
    expect(prisma.balanceTransaction.aggregate).toHaveBeenNthCalledWith(1, {
      where: { userId: 'u1', type: 'CHANNEL_REVENUE', createdAt: { gte: new Date(fromIso) } },
      _sum: { amount: true },
    });
    const where = (prisma.channel.findMany as jest.Mock).mock.calls[0][0].where;
    expect(where.ownerType).toBe('USER');
    expect(where.ownerUserId).toBe('u1');
    expect(where.OR).toBeUndefined();
  });

  it('区间模式渠道：按区间日志聚合分成，只列区间内有收益的渠道并按收益降序', async () => {
    const prisma = makePrisma();
    prisma.requestLog.groupBy = jest.fn().mockResolvedValue([
      {
        channelId: 'c2',
        _count: 3,
        _sum: { channelRevenue: '5.5' },
        _max: { createdAt: new Date('2026-03-01T00:00:00Z') },
      },
      {
        channelId: 'c1',
        _count: 1,
        _sum: { channelRevenue: '2.25' },
        _max: { createdAt: new Date('2026-05-04T00:00:00Z') },
      },
    ]);
    const { service } = makeService(prisma);
    const res = await service.getRevenue('u1', { from: fromIso, to: toIso });
    // 不用 shareRevenue 全量列（切不了区间），按区间分成降序
    expect(res.channels).toEqual([
      {
        id: 'c2',
        name: 'shared-b',
        shareMode: 'GROUP',
        status: 'DISABLED',
        revenue: 5.5,
        calls: 3,
        lastAt: new Date('2026-03-01T00:00:00Z'),
      },
      {
        id: 'c1',
        name: 'shared-a',
        shareMode: 'PUBLIC',
        status: 'ENABLED',
        revenue: 2.25,
        calls: 1,
        lastAt: new Date('2026-05-04T00:00:00Z'),
      },
    ]);
    const gw = (prisma.requestLog.groupBy as jest.Mock).mock.calls[0][0];
    expect(gw.where.createdAt).toEqual({ gte: new Date(fromIso), lte: new Date(toIso) });
    expect(gw.where.channelRevenue).toEqual({ gt: 0 });
    expect(gw._sum).toEqual({ channelRevenue: true });
  });

  it('区间内零收益的渠道不进结果（哪怕全量累计有收益）', async () => {
    const prisma = makePrisma();
    prisma.requestLog.groupBy = jest.fn().mockResolvedValue([]);
    const { service } = makeService(prisma);
    const res = await service.getRevenue('u1', { from: fromIso, to: toIso });
    expect(res.channels).toEqual([]);
  });

  it('thisMonth 不随区间变化：始终按当前 UTC+8 自然月窗口', async () => {
    const { service, prisma } = makeService();
    const res = await service.getRevenue('u1', { from: fromIso, to: toIso });
    expect(res.thisMonth).toBe(12.5);
    const monthWhere = (prisma.balanceTransaction.aggregate as jest.Mock).mock.calls[1][0].where;
    const start = monthWhere.createdAt.gte as Date;
    const local = new Date(start.getTime() + 8 * 3600_000);
    const now8 = new Date(Date.now() + 8 * 3600_000);
    expect(local.getUTCDate()).toBe(1);
    expect(local.getUTCFullYear()).toBe(now8.getUTCFullYear());
    expect(local.getUTCMonth()).toBe(now8.getUTCMonth());
  });

  it('非法日期 / from 晚于 to → BadRequest', async () => {
    const { service } = makeService();
    await expect(service.getRevenue('u1', { from: 'not-a-date' })).rejects.toThrow(
      BadRequestException,
    );
    await expect(
      service.getRevenue('u1', {
        from: '2026-06-01T00:00:00.000Z',
        to: '2026-05-01T00:00:00.000Z',
      }),
    ).rejects.toThrow(BadRequestException);
    await expect(service.getRevenue('u1', { to: '2026-13-45T00:00:00.000Z' })).rejects.toThrow(
      BadRequestException,
    );
  });
});
