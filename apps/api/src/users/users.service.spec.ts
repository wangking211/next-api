import { UsersService } from './users.service';
import { PrismaService } from '../prisma/prisma.service';

describe('UsersService.list 筛选与排序', () => {
  function svc() {
    const prisma = {
      user: {
        findMany: jest.fn().mockResolvedValue([]),
        count: jest.fn().mockResolvedValue(0),
      },
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
});
