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
});
