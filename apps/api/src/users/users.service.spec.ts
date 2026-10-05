import { UsersService } from './users.service';
import { PrismaService } from '../prisma/prisma.service';
import * as bcrypt from 'bcryptjs';

describe('UsersService.list 筛选与排序', () => {
  function svc() {
    const prisma = {
      user: {
        findMany: jest.fn().mockResolvedValue([]),
        count: jest.fn().mockResolvedValue(0),
        update: jest.fn().mockResolvedValue({}),
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

  it('有无 Key / 有无渠道筛选', async () => {
    const { service, prisma } = svc();
    await service.list({ hasKeys: true, hasChannels: false });
    const arg = prisma.user.findMany.mock.calls[0][0];
    expect(arg.where.apiKeys).toEqual({ some: {} });
    expect(arg.where.channels).toEqual({ none: {} });
  });

  it('按最后活跃排序时显式 nulls:last（从未调用者排末尾）', async () => {
    const { service, prisma } = svc();
    await service.list({ sortBy: 'lastActiveAt', sortOrder: 'desc' });
    const arg = prisma.user.findMany.mock.calls[0][0];
    expect(arg.orderBy).toEqual({ lastActiveAt: { sort: 'desc', nulls: 'last' } });
    // 物化列直读：不再按页做 RequestLog 聚合
    expect(arg.select.lastActiveAt).toBe(true);
  });

  it('列表项直接携带物化的 lastActiveAt', async () => {
    const { service, prisma } = svc();
    const when = new Date('2026-09-29T10:00:00Z');
    prisma.user.findMany.mockResolvedValue([
      { id: 'u1', lastActiveAt: when },
      { id: 'u2', lastActiveAt: null },
    ]);
    const res = await service.list();
    expect(res.items[0].lastActiveAt).toEqual(when);
    expect(res.items[1].lastActiveAt).toBeNull();
  });

  it('touchLastActive 更新列且吞掉失败', async () => {
    const { service, prisma } = svc();
    await service.touchLastActive('u1');
    expect(prisma.user.update).toHaveBeenCalledWith({
      where: { id: 'u1' },
      data: { lastActiveAt: expect.any(Date) },
    });
    prisma.user.update.mockRejectedValueOnce(new Error('db down'));
    await expect(service.touchLastActive('u1')).resolves.toBeUndefined();
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
        lastActiveAt: new Date('2026-09-29T10:00:00Z'),
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
    expect(row).toContain('2026-09-29T10:00:00.000Z');
    expect(row).toContain('"a,b"'); // 含逗号的字段被转义
    expect(prisma.user.findMany.mock.calls[0][0].where.apiKeys).toEqual({ some: {} });
  });
});

/**
 * 登录标识查找：邮箱注册时已小写化、用户名按输入原样存，
 * 所以先精确匹配、未命中再大小写不敏感回退（用户不该因为多打一个大写字母被当成密码错误）。
 */
describe('UsersService 登录标识查找', () => {
  function svc(results: Array<unknown>) {
    const findFirst = jest.fn();
    for (const r of results) findFirst.mockResolvedValueOnce(r);
    const prisma = { user: { findFirst } };
    return { service: new UsersService(prisma as unknown as PrismaService), findFirst };
  }

  it('原样命中时只查一次，不再做大小写回退', async () => {
    const { service, findFirst } = svc([{ id: 'u1' }]);
    await expect(service.findByEmailOrUsername('admin')).resolves.toMatchObject({ id: 'u1' });
    expect(findFirst).toHaveBeenCalledTimes(1);
    expect(findFirst).toHaveBeenCalledWith({
      where: { OR: [{ email: 'admin' }, { username: 'admin' }] },
    });
  });

  it('大小写不同时回退到 insensitive 查询（并先 trim）', async () => {
    const { service, findFirst } = svc([null, { id: 'u1' }]);
    await expect(service.findByEmailOrUsername('  Admin  ')).resolves.toMatchObject({ id: 'u1' });
    expect(findFirst).toHaveBeenCalledTimes(2);
    expect(findFirst.mock.calls[1][0]).toEqual({
      where: {
        OR: [
          { email: { equals: 'Admin', mode: 'insensitive' } },
          { username: { equals: 'Admin', mode: 'insensitive' } },
        ],
      },
    });
  });

  it('空标识直接返回 null 且不发查询', async () => {
    const { service, findFirst } = svc([]);
    await expect(service.findByEmailOrUsername('   ')).resolves.toBeNull();
    expect(findFirst).not.toHaveBeenCalled();
  });

  it('注册查重按大小写不敏感匹配用户名', async () => {
    const { service, findFirst } = svc([{ id: 'u2' }]);
    await service.findByUsernameInsensitive(' Admin ');
    expect(findFirst).toHaveBeenCalledWith({
      where: { username: { equals: 'Admin', mode: 'insensitive' } },
    });
  });
});

describe('UsersService.setPassword 管理员/自助重置密码', () => {
  function svc() {
    const prisma = { user: { update: jest.fn().mockResolvedValue({ id: 'u1' }) } };
    return { service: new UsersService(prisma as unknown as PrismaService), prisma };
  }

  it('入参是明文，服务内完成 bcrypt 哈希，并自增 tokenVersion 强制下线旧会话', async () => {
    const { service, prisma } = svc();

    await service.setPassword('u1', 'newpass123');

    const arg = prisma.user.update.mock.calls[0][0];
    expect(arg.where).toEqual({ id: 'u1' });
    expect(arg.data.passwordHash).not.toBe('newpass123');
    await expect(bcrypt.compare('newpass123', arg.data.passwordHash)).resolves.toBe(true);
    // 不是明文、也不是空串，且确实要求自增（幂等写死值会让旧会话继续有效）
    expect(arg.data.tokenVersion).toEqual({ increment: 1 });
  });

  it('未传 opts 时不写 emailVerified（管理员重置不篡改邮箱验证状态）', async () => {
    const { service, prisma } = svc();

    await service.setPassword('u1', 'newpass123');

    expect(prisma.user.update.mock.calls[0][0].data).not.toHaveProperty('emailVerified');
  });

  it('自助找回密码带 emailVerified=true 时才落库', async () => {
    const { service, prisma } = svc();

    await service.setPassword('u1', 'newpass123', { emailVerified: true });

    expect(prisma.user.update.mock.calls[0][0].data.emailVerified).toBe(true);
  });
});
