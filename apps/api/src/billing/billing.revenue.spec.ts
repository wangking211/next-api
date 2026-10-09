import { BillingService } from './billing.service';
import { PrismaService } from '../prisma/prisma.service';

/**
 * BillingService.getRevenue（「我的收益」汇总）：
 * - total 走账本（BalanceTransaction CHANNEL_REVENUE 累计，Decimal → number）
 * - months 走原始 SQL（UTC+8 归月，近 12 月窗口）
 * - channels 走 Channel.shareRevenue（O(1) 列）+ RequestLog groupBy 补调用统计
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
      groupBy: jest
        .fn()
        .mockResolvedValue([
          { channelId: 'c1', _count: 7, _max: { createdAt: new Date('2026-10-01T02:03:04Z') } },
        ]),
    },
  };
}

function makeService(prisma = makePrisma()) {
  const service = new BillingService(prisma as unknown as PrismaService);
  return { service, prisma };
}

describe('BillingService.getRevenue（我的收益汇总）', () => {
  it('total 用账本累计并 Decimal → number，months 原样映射', async () => {
    const { service, prisma } = makeService();
    const res = await service.getRevenue('u1');
    expect(res.total).toBe(12.5);
    expect(res.months).toEqual([
      { month: '2026-09', revenue: 3.5 },
      { month: '2026-10', revenue: 1.25 },
    ]);
    expect(prisma.balanceTransaction.aggregate).toHaveBeenCalledWith({
      where: { userId: 'u1', type: 'CHANNEL_REVENUE' },
      _sum: { amount: true },
    });
  });

  it('月份原始 SQL 带 userId 与近 12 月窗口起点（UTC+8 月初对应的 UTC 时刻）', async () => {
    const { service, prisma } = makeService();
    await service.getRevenue('u1');
    const args = (prisma.$queryRaw as jest.Mock).mock.calls[0];
    // 标签模板：args[0] 为字符串片段，之后依次是 userId、窗口起点
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
