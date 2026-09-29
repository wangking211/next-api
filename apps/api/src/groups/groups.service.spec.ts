import { ModelOrigin, ModelGroupStatus } from '@prisma/client';
import { GroupsService } from './groups.service';
import { PrismaService } from '../prisma/prisma.service';

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

function makeService(opts: {
  byId?: Record<string, unknown | null>;
  userGroupId?: string | null;
  defaultGroup?: unknown | null;
  userFound?: boolean;
}) {
  const prisma = {
    modelGroup: {
      findFirst: jest.fn(async ({ where }: any) => {
        if (where?.id) return opts.byId?.[where.id] ?? null;
        if (where?.isDefault) return opts.defaultGroup ?? null;
        return null;
      }),
    },
    user: {
      findUnique: jest.fn(async () =>
        (opts.userFound ?? true) ? { groupId: opts.userGroupId ?? null } : null,
      ),
    },
  };
  return { service: new GroupsService(prisma as unknown as PrismaService), prisma };
}

describe('GroupsService.effectiveGroup', () => {
  it('令牌分组优先于用户分组', async () => {
    const keyGroup = group({ id: 'gk', name: 'vip', ratio: 0.8, models: [{ name: 'gpt-5.5' }] });
    const { service } = makeService({
      byId: { gk: keyGroup },
      userGroupId: 'gu',
    });
    const g = await service.effectiveGroup('u1', 'gk');
    expect(g).toMatchObject({ id: 'gk', name: 'vip', ratio: 0.8, models: ['gpt-5.5'] });
  });

  it('令牌分组不可用（已禁用/不存在）时回退用户分组', async () => {
    const userGroup = group({ id: 'gu', name: 'basic', ratio: 1.2 });
    const { service } = makeService({ byId: { gu: userGroup }, userGroupId: 'gu' });
    const g = await service.effectiveGroup('u1', 'missing');
    expect(g).toMatchObject({ id: 'gu', name: 'basic', ratio: 1.2 });
  });

  it('用户无分组时回退默认分组', async () => {
    const def = group({ id: 'gd', name: 'default', isDefault: true });
    const { service } = makeService({ defaultGroup: def, userGroupId: null });
    const g = await service.effectiveGroup('u1', null);
    expect(g).toMatchObject({ id: 'gd', name: 'default', ratio: null, models: [] });
  });

  it('无任何可用分组时返回不限制的空分组（兼容历史数据）', async () => {
    const { service } = makeService({ defaultGroup: null, userGroupId: null });
    const g = await service.effectiveGroup('u1');
    expect(g).toEqual({ id: null, name: 'default', ratio: null, models: [] });
  });

  it('ratio 为空表示不参与倍率（回退用户/代理倍率）', async () => {
    const g = group({ id: 'gx', ratio: null });
    const { service } = makeService({ byId: { gx: g } });
    expect((await service.effectiveGroup('u1', 'gx')).ratio).toBeNull();
  });

  it('ratio 为 Decimal 时转为 number', async () => {
    const g = group({ id: 'gy', ratio: { toString: () => '0.6500' } });
    const { service } = makeService({ byId: { gy: g } });
    expect((await service.effectiveGroup('u1', 'gy')).ratio).toBe(0.65);
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
    expect((await service.effectiveGroup('u1', 'g2')).models).toEqual(['a', 'b']);
  });
});
