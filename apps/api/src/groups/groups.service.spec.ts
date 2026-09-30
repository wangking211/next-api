import { ModelGroupStatus } from '@prisma/client';
import { GroupsService } from './groups.service';
import { PrismaService } from '../prisma/prisma.service';
import { TtlCacheService } from '../common/ttl-cache.service';

function group(over: Partial<Record<string, unknown>>) {
  return {
    id: 'g1',
    name: 'default',
    displayName: '默认分组',
    description: null,
    ratio: null,
    status: ModelGroupStatus.ENABLED,
    priority: 0,
    isDefault: false,
    models: [],
    ...over,
  };
}

function makeService(
  opts: {
    byId?: Record<string, unknown | null>;
    userGroupId?: string | null;
    defaultGroup?: unknown | null;
    userFound?: boolean;
  },
  cache?: TtlCacheService,
) {
  const prisma = {
    modelGroup: {
      findFirst: jest.fn(async ({ where }: any) => {
        if (where?.id) return opts.byId?.[where.id] ?? null;
        if (where?.isDefault) return opts.defaultGroup ?? null;
        return null;
      }),
      findUnique: jest.fn(async ({ where }: any) => opts.byId?.[where.id] ?? null),
      delete: jest.fn(async () => ({})),
    },
    user: {
      findUnique: jest.fn(async () =>
        (opts.userFound ?? true) ? { groupId: opts.userGroupId ?? null } : null,
      ),
    },
  };
  return {
    service: new GroupsService(prisma as unknown as PrismaService, cache),
    prisma,
    cache,
  };
}

describe('GroupsService.effectiveGroup', () => {
  it('令牌分组优先于用户分组', async () => {
    const keyGroup = group({ id: 'gk', name: 'vip', ratio: 0.8, models: [{ name: 'gpt-5.5' }] });
    const { service } = makeService({
      byId: { gk: keyGroup },
      userGroupId: 'gu',
    });
    const g = await service.effectiveGroup({ id: 'u1' }, 'gk');
    expect(g).toMatchObject({ id: 'gk', name: 'vip', ratio: 0.8, models: ['gpt-5.5'] });
  });

  it('令牌分组不可用（已禁用/不存在）时回退用户分组', async () => {
    const userGroup = group({ id: 'gu', name: 'basic', ratio: 1.2 });
    const { service } = makeService({ byId: { gu: userGroup }, userGroupId: 'gu' });
    const g = await service.effectiveGroup({ id: 'u1' }, 'missing');
    expect(g).toMatchObject({ id: 'gu', name: 'basic', ratio: 1.2 });
  });

  it('用户无分组时回退默认分组', async () => {
    const def = group({ id: 'gd', name: 'default', isDefault: true });
    const { service } = makeService({ defaultGroup: def, userGroupId: null });
    const g = await service.effectiveGroup({ id: 'u1' }, null);
    expect(g).toMatchObject({ id: 'gd', name: 'default', ratio: null, models: [] });
  });

  it('无任何可用分组时返回不限制的空分组（兼容历史数据）', async () => {
    const { service } = makeService({ defaultGroup: null, userGroupId: null });
    const g = await service.effectiveGroup({ id: 'u1' });
    expect(g).toEqual({ id: null, name: 'default', ratio: null, models: [] });
  });

  it('ratio 为空表示不参与倍率（回退用户/代理倍率）', async () => {
    const g = group({ id: 'gx', ratio: null });
    const { service } = makeService({ byId: { gx: g } });
    expect((await service.effectiveGroup({ id: 'u1' }, 'gx')).ratio).toBeNull();
  });

  it('ratio 为 Decimal 时转为 number', async () => {
    const g = group({ id: 'gy', ratio: { toString: () => '0.6500' } });
    const { service } = makeService({ byId: { gy: g } });
    expect((await service.effectiveGroup({ id: 'u1' }, 'gy')).ratio).toBe(0.65);
  });

  it('调用方已带 user.groupId 时不再回查用户表（网关热路径 0 用户查询）', async () => {
    const userGroup = group({ id: 'gu', name: 'basic', ratio: 1.1 });
    const { service, prisma } = makeService({ byId: { gu: userGroup } });
    const g = await service.effectiveGroup({ id: 'u1', groupId: 'gu' });
    expect(g).toMatchObject({ id: 'gu', ratio: 1.1 });
    expect(prisma.user.findUnique).not.toHaveBeenCalled();
  });

  it('user.groupId 为 null 时直接走默认分组（不回查用户表）', async () => {
    const def = group({ id: 'gd', name: 'default', isDefault: true });
    const { service, prisma } = makeService({ defaultGroup: def });
    const g = await service.effectiveGroup({ id: 'u1', groupId: null });
    expect(g.id).toBe('gd');
    expect(prisma.user.findUnique).not.toHaveBeenCalled();
  });
});

describe('GroupsService 可见性', () => {
  const { service } = makeService({});

  it('分组未配置可见模型 = 不限制', () => {
    const g = { id: 'g1', name: 'x', ratio: null, models: [] };
    expect(service.isModelVisible(g, 'anything')).toBe(true);
  });

  it('已配置可见模型时按白名单判断', () => {
    const g = { id: 'g1', name: 'cn', ratio: null, models: ['deepseek-v4-flash'] };
    expect(service.isModelVisible(g, 'deepseek-v4-flash')).toBe(true);
    expect(service.isModelVisible(g, 'gpt-5.5')).toBe(false);
  });

  it('渠道可见性：无分组时返回 null（调用方回退为不限制）', () => {
    expect(service.channelVisibilityWhere(null)).toBeNull();
  });

  it('渠道可见性：公共渠道 + 同分组渠道', () => {
    const where: any = service.channelVisibilityWhere('g1');
    expect(where.OR).toHaveLength(2);
    expect(where.OR[0]).toEqual({ groups: { none: {} } });
    expect(where.OR[1]).toEqual({ groups: { some: { id: 'g1' } } });
  });
});

describe('GroupsService 分组模型解析', () => {
  it('effectiveGroup 的 models 取自目录关联', async () => {
    const g = group({ id: 'g2', models: [{ name: 'a' }, { name: 'b' }] });
    const { service } = makeService({ byId: { g2: g } });
    expect((await service.effectiveGroup({ id: 'u1' }, 'g2')).models).toEqual(['a', 'b']);
  });
});

describe('GroupsService 分组行缓存', () => {
  const idLookups = (prisma: any) =>
    prisma.modelGroup.findFirst.mock.calls.filter((c: any[]) => c[0]?.where?.id).length;

  it('同一分组 id 在 TTL 内只查一次库（网关热路径免 DB）', async () => {
    const g = group({ id: 'gk', ratio: 0.8 });
    const { service, prisma } = makeService({ byId: { gk: g } }, new TtlCacheService());

    await service.effectiveGroup({ id: 'u1' }, 'gk');
    await service.effectiveGroup({ id: 'u1' }, 'gk');
    await service.effectiveGroup({ id: 'u1' }, 'gk');

    expect(idLookups(prisma)).toBe(1);
  });

  it('不存在的分组 id 也缓存结果（不反复打库）', async () => {
    const cache = new TtlCacheService();
    const { service, prisma } = makeService({ byId: {}, userGroupId: null }, cache);

    await service.effectiveGroup({ id: 'u1' }, 'missing');
    await service.effectiveGroup({ id: 'u1' }, 'missing');

    expect(idLookups(prisma)).toBe(1);
    // 缓存里确实存了「不存在」这个结果
    expect(cache.get('groups:rows:id:missing')).toBeNull();
  });

  it('CRUD 失效后立即重新加载', async () => {
    const g = group({ id: 'gk', ratio: 0.8 });
    const { service, prisma } = makeService({ byId: { gk: g } }, new TtlCacheService());

    await service.effectiveGroup({ id: 'u1' }, 'gk');
    expect(idLookups(prisma)).toBe(1);

    await service.remove('gk'); // 内部会 invalidate('groups:rows')

    await service.effectiveGroup({ id: 'u1' }, 'gk');
    expect(idLookups(prisma)).toBe(2);
  });
});
