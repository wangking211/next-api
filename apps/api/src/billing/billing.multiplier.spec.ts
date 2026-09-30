import { BillingService } from './billing.service';
import { PrismaService } from '../prisma/prisma.service';

/** 倍率解析优先级：用户个人 > 分组 > 所属代理 > 1（互斥优先，不叠乘） */
describe('BillingService.getBillingMultiplier', () => {
  function svc(user: unknown) {
    const prisma = { user: { findUnique: jest.fn().mockResolvedValue(user) } };
    return new BillingService(prisma as unknown as PrismaService);
  }

  it('用户个人倍率优先级最高（忽略分组与代理）', async () => {
    const s = svc({ priceMultiplier: 1.5, agent: { priceMultiplier: 0.9 } });
    await expect(s.getBillingMultiplier('u', 0.8)).resolves.toEqual({
      value: 1.5,
      source: 'user',
    });
  });

  it('无个人倍率时用分组倍率', async () => {
    const s = svc({ priceMultiplier: null, agent: { priceMultiplier: 0.9 } });
    await expect(s.getBillingMultiplier('u', 0.8)).resolves.toEqual({
      value: 0.8,
      source: 'group',
    });
  });

  it('分组倍率为空（未配置）时回退代理倍率', async () => {
    const s = svc({ priceMultiplier: null, agent: { priceMultiplier: 0.9 } });
    await expect(s.getBillingMultiplier('u', null)).resolves.toEqual({
      value: 0.9,
      source: 'agent',
    });
    await expect(s.getBillingMultiplier('u')).resolves.toEqual({
      value: 0.9,
      source: 'agent',
    });
  });

  it('都未配置时倍率为 1', async () => {
    const s = svc({ priceMultiplier: null, agent: null });
    await expect(s.getBillingMultiplier('u')).resolves.toEqual({
      value: 1,
      source: 'default',
    });
  });

  it('非正倍率视为无效并回退', async () => {
    const s = svc({ priceMultiplier: 0, agent: null });
    await expect(s.getBillingMultiplier('u', 0)).resolves.toEqual({
      value: 1,
      source: 'default',
    });
  });

  it('用户不存在时安全回退为 1（不抛错）', async () => {
    const s = svc(null);
    await expect(s.getBillingMultiplier('u', 0.5)).resolves.toEqual({
      value: 1,
      source: 'default',
    });
  });

  it('getUserMultiplier 兼容旧调用（不含分组）', async () => {
    const s = svc({ priceMultiplier: 1.25, agent: null });
    await expect(s.getUserMultiplier('u')).resolves.toBe(1.25);
  });

  describe('snapshot（调用方已持有用户行时 0 查询）', () => {
    function svcWith(prisma: unknown) {
      return new BillingService(prisma as unknown as PrismaService);
    }

    it('snapshot 自带个人倍率 → 完全不查库', async () => {
      const prisma = { user: { findUnique: jest.fn() } };
      const s = svcWith(prisma);
      await expect(
        s.getBillingMultiplier('u', 0.8, { priceMultiplier: 1.5, agentId: 'a1' }),
      ).resolves.toEqual({ value: 1.5, source: 'user' });
      expect(prisma.user.findUnique).not.toHaveBeenCalled();
    });

    it('snapshot 无个人倍率 → 用分组倍率，仍不查库', async () => {
      const prisma = { user: { findUnique: jest.fn() } };
      const s = svcWith(prisma);
      await expect(
        s.getBillingMultiplier('u', 0.8, { priceMultiplier: null, agentId: 'a1' }),
      ).resolves.toEqual({ value: 0.8, source: 'group' });
      expect(prisma.user.findUnique).not.toHaveBeenCalled();
    });

    it('只有代理时才查 1 次代理倍率', async () => {
      const prisma = {
        user: { findUnique: jest.fn().mockResolvedValue({ priceMultiplier: 0.9 }) },
      };
      const s = svcWith(prisma);
      await expect(
        s.getBillingMultiplier('u', null, { priceMultiplier: null, agentId: 'a1' }),
      ).resolves.toEqual({ value: 0.9, source: 'agent' });
      expect(prisma.user.findUnique).toHaveBeenCalledTimes(1);
      expect(prisma.user.findUnique).toHaveBeenCalledWith(
        expect.objectContaining({ where: { id: 'a1' } }),
      );
    });

    it('无个人/分组/代理 → 默认 1 且 0 查询', async () => {
      const prisma = { user: { findUnique: jest.fn() } };
      const s = svcWith(prisma);
      await expect(
        s.getBillingMultiplier('u', null, { priceMultiplier: null, agentId: null }),
      ).resolves.toEqual({ value: 1, source: 'default' });
      expect(prisma.user.findUnique).not.toHaveBeenCalled();
    });

    it('代理存在但未配倍率 → 回退默认 1', async () => {
      const prisma = {
        user: { findUnique: jest.fn().mockResolvedValue({ priceMultiplier: null }) },
      };
      const s = svcWith(prisma);
      await expect(
        s.getBillingMultiplier('u', null, { priceMultiplier: null, agentId: 'a1' }),
      ).resolves.toEqual({ value: 1, source: 'default' });
    });
  });
});
