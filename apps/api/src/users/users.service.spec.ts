import { UsersService } from './users.service';
import { PrismaService } from '../prisma/prisma.service';

describe('UsersService.list 筛选与排序', () => {
  function svc() {
    const prisma = {
      user: {
        findMany: jest.fn().mockResolvedValue([]),
        count: jest.fn().mockResolvedValue(0),
      },
      requestLog: { groupBy: jest.fn().mockResolvedValue([]) },
    };
    return { service: new UsersService(prisma as unknown as PrismaService), prisma };
  }

  it('组合筛选：关键词/角色/状态/分组/代理/余额区间/注册时间 + 排序 + 分页', async () => {
    const { service, prisma } = svc();
    await service.list({
      q: 'ab',
      role: 'USER',
      status: 'BANNED',
      groupId: 'g1',
      agentId: 'a1',
      balanceMin: 1,
      balanceMax: 10,
      createdFrom: new Date('2026-01-01T00:00:00Z'),
      createdTo: new Date('2026-02-01T00:00:00Z'),
      sortBy: 'balance',
      sortOrder: 'asc',
      page: 2,
      pageSize: 50,
    });
    const arg = prisma.user.findMany.mock.calls[0][0];
    expect(arg.where.role).toBe('USER');
    expect(arg.where.status).toBe('BANNED');
    expect(arg.where.groupId).toBe('g1');
    expect(arg.where.agentId).toBe('a1');
    expect(arg.where.balance).toEqual({ gte: 1, lte: 10 });
    expect(arg.where.createdAt.gte).toEqual(new Date('2026-01-01T00:00:00Z'));
    expect(arg.where.createdAt.lte).toEqual(new Date('2026-02-01T00:00:00Z'));
    expect(arg.where.OR).toHaveLength(2);
    expect(arg.orderBy).toEqual({ balance: 'asc' });
    expect(arg.skip).toBe(50);
    expect(arg.take).toBe(50);
    expect(prisma.user.count).toHaveBeenCalledWith({ where: arg.where });
  });

  it('未提供筛选时不附加条件，默认按注册时间倒序', async () => {
    const { service, prisma } = svc();
    await service.list();
    const arg = prisma.user.findMany.mock.calls[0][0];
    expect(arg.where).toEqual({});
    expect(arg.orderBy).toEqual({ createdAt: 'desc' });
    expect(arg.skip).toBe(0);
    expect(arg.take).toBe(20);
  });

  it('只给余额上界时仅带 lte', async () => {
    const { service, prisma } = svc();
    await service.list({ balanceMax: 5 });
    const arg = prisma.user.findMany.mock.calls[0][0];
    expect(arg.where.balance).toEqual({ lte: 5 });
  });

  it('有无 Key / 有无渠道筛选', async () => {
    const { service, prisma } = svc();
    await service.list({ hasKeys: true, hasChannels: false });
    const arg = prisma.user.findMany.mock.calls[0][0];
    expect(arg.where.apiKeys).toEqual({ some: {} });
    expect(arg.where.channels).toEqual({ none: {} });
  });

  it('最后活跃时间由调用明细聚合派生并挂到列表项', async () => {
    const { service, prisma } = svc();
    const when = new Date('2026-09-29T10:00:00Z');
    prisma.user.findMany.mockResolvedValue([{ id: 'u1' }, { id: 'u2' }]);
    prisma.requestLog.groupBy.mockResolvedValue([
      { userId: 'u1', _max: { createdAt: when } },
    ]);
    const res = await service.list();
    expect(res.items[0]).toEqual({ id: 'u1', lastActiveAt: when });
    expect(res.items[1]).toEqual({ id: 'u2', lastActiveAt: null });
    expect(prisma.requestLog.groupBy).toHaveBeenCalledTimes(1);
  });

  it('CSV 导出复用同一套筛选条件并带上表头', async () => {
    const { service, prisma } = svc();
    prisma.user.findMany.mockResolvedValue([
      {
        id: 'u1',
        email: 'a@b.com',
        username: 'a,b',
        role: 'USER',
        status: 'ACTIVE',
        balance: 1.5,
        priceMultiplier: null,
        rebateRate: null,
        createdAt: new Date('2026-01-01T00:00:00Z'),
        agent: null,
        group: { name: 'default' },
        _count: { apiKeys: 1, channels: 0 },
      },
    ]);
    const { csv, count } = await service.exportCsv({ hasKeys: true });
    expect(count).toBe(1);
    const [header, row] = csv.split('\n');
    expect(header).toContain('lastActiveAt');
    expect(row).toContain('"a,b"'); // 含逗号的字段被转义
    expect(prisma.user.findMany.mock.calls[0][0].where.apiKeys).toEqual({ some: {} });
  });
});
