import { NotFoundException } from '@nestjs/common';
import { ApiKeyStatus } from '@prisma/client';
import { KeysService } from './keys.service';
import { PrismaService } from '../prisma/prisma.service';
import { CryptoService } from '../common/crypto.service';
import { GroupsService } from '../groups/groups.service';
import { UpstreamProbeService } from '../gateway/providers/upstream-probe.service';

function makeService() {
  const tx = {
    usageDaily: {
      findMany: jest.fn(),
      findFirst: jest.fn(),
      update: jest.fn(),
      delete: jest.fn(),
    },
    apiKey: { delete: jest.fn() },
  };
  const prisma = {
    apiKey: {
      findMany: jest.fn(),
      create: jest.fn(),
      findFirst: jest.fn(),
      update: jest.fn(),
      // 与事务内 tx.apiKey.delete 共享同一 mock：断言只维护一份
      delete: tx.apiKey.delete,
    },
    usageDaily: tx.usageDaily,
    modelCatalog: { findFirst: jest.fn().mockResolvedValue(null) },
    channelModel: {
      findMany: jest.fn().mockResolvedValue([]),
      count: jest.fn().mockResolvedValue(0),
    },
    // 交互式事务：直接把预置的 tx 交给回调
    $transaction: jest.fn(async (fn: (t: typeof tx) => Promise<unknown>) => fn(tx)),
  };
  const crypto = {
    generateApiKey: jest
      .fn()
      .mockReturnValue({ plaintext: 'sk-plain-xyz', hash: 'HASHED', prefix: 'sk-abc' }),
    decrypt: jest.fn().mockReturnValue('upstream-key'),
  };
  const groups = {
    effectiveGroup: jest
      .fn()
      .mockResolvedValue({ id: null, name: 'default', ratio: null, models: [] }),
    channelScopeWhere: jest.fn().mockReturnValue({}),
    isModelVisible: jest.fn().mockReturnValue(true),
  };
  const probe = {
    run: jest.fn().mockResolvedValue({
      ok: true,
      status: 200,
      latencyMs: 42,
      model: 'm1',
      provider: 'openai',
      sample: 'pong',
    }),
  };
  const service = new KeysService(
    prisma as unknown as PrismaService,
    crypto as unknown as CryptoService,
    groups as unknown as GroupsService,
    probe as unknown as UpstreamProbeService,
  );
  return { service, prisma, tx, groups, probe };
}

const row = {
  id: 'k1',
  name: 'my key',
  keyPrefix: 'sk-abc',
  keyHash: 'HASHED',
  status: ApiKeyStatus.ACTIVE,
  quotaLimit: null,
  quotaUsed: 0,
  costLimit: null,
  costUsed: 0,
  rpmLimit: null,
  routingStrategy: null,
  tpmLimit: null,
  models: ['m1'],
  groupId: null,
  group: null,
  expiresAt: null,
  lastUsedAt: null,
  createdAt: new Date('2026-01-01T00:00:00Z'),
};

describe('KeysService.create', () => {
  it('明文只返回一次；库里存哈希、行内只留前缀', async () => {
    const { service, prisma } = makeService();
    prisma.apiKey.create.mockResolvedValue(row);

    const out = await service.create('u1', { name: 'my key' });

    expect(out.plaintext).toBe('sk-plain-xyz');
    expect(out.warning).toMatch(/not be shown again/);
    expect(out).not.toHaveProperty('keyHash'); // publicView 不透出哈希

    const data = prisma.apiKey.create.mock.calls[0][0].data;
    expect(data.keyHash).toBe('HASHED');
    expect(data.keyPrefix).toBe('sk-abc');
    expect(data.userId).toBe('u1');
    expect(JSON.stringify(out)).not.toContain('HASHED');
  });

  it('分组只允许管理员指定：非管理员传了 groupId 也强制 null', async () => {
    const { service, prisma } = makeService();
    prisma.apiKey.create.mockResolvedValue(row);

    await service.create('u1', { name: 'n', groupId: 'g9' });
    expect(prisma.apiKey.create.mock.calls[0][0].data.groupId).toBeNull();

    await service.create('u1', { name: 'n', groupId: 'g9' }, true);
    expect(prisma.apiKey.create.mock.calls[1][0].data.groupId).toBe('g9');
  });

  it('allowedChannelIds 归一：trim + 去空 + 去重；缺省存空数组（不限制）', async () => {
    const { service, prisma } = makeService();
    prisma.apiKey.create.mockResolvedValue({ ...row, allowedChannelIds: ['c1', 'c2'] });

    await service.create('u1', { name: 'n', allowedChannelIds: [' c1 ', 'c2', '', 'c1'] });
    expect(prisma.apiKey.create.mock.calls[0][0].data.allowedChannelIds).toEqual(['c1', 'c2']);

    await service.create('u1', { name: 'n2' });
    expect(prisma.apiKey.create.mock.calls[1][0].data.allowedChannelIds).toEqual([]);
  });
});

describe('KeysService.list', () => {
  it('前缀只显掩码（sk-abc...），且不带 plaintext/keyHash', async () => {
    const { service, prisma } = makeService();
    prisma.apiKey.findMany.mockResolvedValue([row]);

    const keys = await service.list('u1');

    expect(keys).toHaveLength(1);
    expect(keys[0].keyPrefix).toBe('sk-abc...');
    expect(keys[0]).not.toHaveProperty('plaintext');
    expect(keys[0]).not.toHaveProperty('keyHash');
    expect(prisma.apiKey.findMany).toHaveBeenCalledWith(
      expect.objectContaining({ where: { userId: 'u1' } }),
    );
  });

  it('透出 allowedChannelIds；旧数据缺字段时回退空数组（不限制）', async () => {
    const { service, prisma } = makeService();
    prisma.apiKey.findMany.mockResolvedValue([
      { ...row, allowedChannelIds: ['c1'] },
      { ...row, id: 'k2', allowedChannelIds: undefined },
    ]);

    const keys = await service.list('u1');

    expect(keys[0].allowedChannelIds).toEqual(['c1']);
    expect(keys[1].allowedChannelIds).toEqual([]);
  });
});

describe('KeysService.update', () => {
  it('分组只允许管理员调整：非管理员传 groupId 被忽略，管理员生效', async () => {
    const { service, prisma } = makeService();
    prisma.apiKey.findFirst.mockResolvedValue(row);
    prisma.apiKey.update.mockResolvedValue(row);

    await service.update('u1', 'k1', { name: 'x', groupId: 'g9' });
    expect(prisma.apiKey.update).toHaveBeenNthCalledWith(1, {
      where: { id: 'k1' },
      data: { name: 'x' },
    });

    await service.update('u1', 'k1', { name: 'x', groupId: 'g9' }, true);
    expect(prisma.apiKey.update).toHaveBeenNthCalledWith(2, {
      where: { id: 'k1' },
      data: { name: 'x', groupId: 'g9' },
    });
  });

  it('models 传空数组 → 清空白名单（data.models = []）', async () => {
    const { service, prisma } = makeService();
    prisma.apiKey.findFirst.mockResolvedValue(row);
    prisma.apiKey.update.mockResolvedValue({ ...row, models: [] });

    await service.update('u1', 'k1', { models: [] });
    expect(prisma.apiKey.update).toHaveBeenCalledWith({
      where: { id: 'k1' },
      data: { models: [] },
    });
  });

  it('allowedChannelIds：null/[] 清空（不限制），不传则不改该字段', async () => {
    const { service, prisma } = makeService();
    prisma.apiKey.findFirst.mockResolvedValue(row);
    prisma.apiKey.update.mockResolvedValue({ ...row, allowedChannelIds: [] });

    await service.update('u1', 'k1', { allowedChannelIds: null });
    expect(prisma.apiKey.update).toHaveBeenNthCalledWith(1, {
      where: { id: 'k1' },
      data: { allowedChannelIds: [] },
    });

    await service.update('u1', 'k1', { allowedChannelIds: ['c1', ' c1 ', ''] });
    expect(prisma.apiKey.update).toHaveBeenNthCalledWith(2, {
      where: { id: 'k1' },
      data: { allowedChannelIds: ['c1'] },
    });

    await service.update('u1', 'k1', { name: 'x' });
    expect(prisma.apiKey.update.mock.calls[2][0].data).not.toHaveProperty('allowedChannelIds');
  });

  it('key 不属于当前用户 → NotFoundException（API_KEY_NOT_FOUND）', async () => {
    const { service, prisma } = makeService();
    prisma.apiKey.findFirst.mockResolvedValue(null);

    const err = await service.update('u1', 'missing', { name: 'x' }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(NotFoundException);
    expect((err as NotFoundException).getResponse()).toEqual({
      code: 'API_KEY_NOT_FOUND',
      message: 'API key not found',
    });
    expect(prisma.apiKey.update).not.toHaveBeenCalled();
  });
});

describe('KeysService.remove（用量并桶后删除）', () => {
  it('同用户同日已有 NULL 桶 → 增量并入后删原行；其余行仅解绑', async () => {
    const { service, prisma } = makeService();
    const D = new Date('2026-02-01T00:00:00Z');
    prisma.apiKey.findFirst.mockResolvedValue(row);
    prisma.usageDaily.findMany.mockResolvedValue([
      {
        id: 'r1',
        userId: 'u1',
        apiKeyId: 'k1',
        date: D,
        requests: 5,
        promptTokens: 10,
        completionTokens: 20,
        totalTokens: 30,
        cost: 0.5,
        billedCost: 0.25,
      },
      {
        id: 'r2',
        userId: 'u2',
        apiKeyId: 'k1',
        date: D,
        requests: 7,
        promptTokens: 1,
        completionTokens: 2,
        totalTokens: 3,
        cost: 0.1,
        billedCost: 0.05,
      },
    ]);
    prisma.usageDaily.findFirst
      .mockResolvedValueOnce({ id: 'null-bucket' }) // r1：同 (user,date) 已有 NULL 桶
      .mockResolvedValueOnce(null); // r2：无
    prisma.usageDaily.update.mockResolvedValue({});
    prisma.usageDaily.delete.mockResolvedValue({});
    prisma.apiKey.delete.mockResolvedValue({});

    const out = await service.remove('u1', 'k1');
    expect(out).toEqual({ success: true });

    // r1 并入 NULL 桶（全字段增量）后删除原行
    expect(prisma.usageDaily.update).toHaveBeenNthCalledWith(1, {
      where: { id: 'null-bucket' },
      data: {
        requests: { increment: 5 },
        promptTokens: { increment: 10 },
        completionTokens: { increment: 20 },
        totalTokens: { increment: 30 },
        cost: { increment: 0.5 },
        billedCost: { increment: 0.25 },
      },
    });
    expect(prisma.usageDaily.delete).toHaveBeenCalledWith({ where: { id: 'r1' } });
    // r2 没有 NULL 桶 → 只解绑
    expect(prisma.usageDaily.update).toHaveBeenNthCalledWith(2, {
      where: { id: 'r2' },
      data: { apiKeyId: null },
    });
    expect(prisma.apiKey.delete).toHaveBeenCalledWith({ where: { id: 'k1' } });
  });

  it('无用量行 → 跳过并桶直接删 key', async () => {
    const { service, prisma } = makeService();
    prisma.apiKey.findFirst.mockResolvedValue(row);
    prisma.usageDaily.findMany.mockResolvedValue([]);
    prisma.apiKey.delete.mockResolvedValue({});

    await expect(service.remove('u1', 'k1')).resolves.toEqual({ success: true });
    expect(prisma.usageDaily.update).not.toHaveBeenCalled();
    expect(prisma.apiKey.delete).toHaveBeenCalledWith({ where: { id: 'k1' } });
  });
});

describe('KeysService.test（测试连通性：诊断探针，不扣费不写调用记录）', () => {
  const channelRow = {
    id: 'ch1',
    name: 'my-channel',
    provider: 'openai',
    baseUrl: 'https://up/v1',
    apiKeyEnc: 'enc',
    ownerType: 'USER',
  };
  const cmRow = { modelName: 'm1', upstreamModelName: 'm1-up', channel: channelRow };

  it('按白名单/可见渠道选一条渠道打最小探针，返回渠道与延迟', async () => {
    const { service, prisma, probe } = makeService();
    prisma.apiKey.findFirst.mockResolvedValue(row);
    prisma.channelModel.findMany.mockResolvedValue([cmRow]);

    const out = await service.test('u1', 'k1');

    expect(out).toMatchObject({
      ok: true,
      model: 'm1',
      upstreamModel: 'm1-up',
      status: 200,
      latencyMs: 42,
    });
    expect(out.channel).toEqual({ id: 'ch1', name: 'my-channel', ownerType: 'USER' });
    expect(probe.run).toHaveBeenCalledWith({
      provider: 'openai',
      baseUrl: 'https://up/v1',
      apiKey: 'upstream-key',
      model: 'm1-up',
    });
    // 诊断口径：不扣费、不写 RequestLog / 用量
    expect(prisma.apiKey.update).not.toHaveBeenCalled();
    expect(prisma.$transaction).not.toHaveBeenCalled();
  });

  it('Key 已停用 → 直接返回 KEY_DISABLED，不打上游', async () => {
    const { service, prisma, probe } = makeService();
    prisma.apiKey.findFirst.mockResolvedValue({ ...row, status: ApiKeyStatus.DISABLED });

    const out = await service.test('u1', 'k1');

    expect(out).toMatchObject({ ok: false, code: 'KEY_DISABLED' });
    expect(probe.run).not.toHaveBeenCalled();
  });

  it('模型不在白名单 → KEY_MODEL_NOT_ALLOWED；:latest 后缀可按白名单命中', async () => {
    const { service, prisma, probe } = makeService();
    prisma.apiKey.findFirst.mockResolvedValue({ ...row, models: ['m2'] });

    await expect(service.test('u1', 'k1', 'm1')).resolves.toMatchObject({
      ok: false,
      code: 'KEY_MODEL_NOT_ALLOWED',
    });
    expect(probe.run).not.toHaveBeenCalled();

    prisma.apiKey.findFirst.mockResolvedValue({ ...row, models: ['m1:latest'] });
    prisma.channelModel.findMany.mockResolvedValue([cmRow]);
    await expect(service.test('u1', 'k1', 'm1')).resolves.toMatchObject({ ok: true });
  });

  it('渠道全部停用 → KEY_TEST_CHANNEL_DISABLED；无渠道支持 → KEY_TEST_NO_CHANNEL', async () => {
    const { service, prisma, probe } = makeService();
    prisma.apiKey.findFirst.mockResolvedValue(row);
    prisma.channelModel.findMany.mockResolvedValue([]);

    prisma.channelModel.count.mockResolvedValueOnce(2);
    await expect(service.test('u1', 'k1', 'm1')).resolves.toMatchObject({
      ok: false,
      code: 'KEY_TEST_CHANNEL_DISABLED',
    });

    prisma.channelModel.count.mockResolvedValueOnce(0);
    await expect(service.test('u1', 'k1', 'm1')).resolves.toMatchObject({
      ok: false,
      code: 'KEY_TEST_NO_CHANNEL',
    });
    expect(probe.run).not.toHaveBeenCalled();
  });

  it('上游 401 → 透出真实错误，便于自助定位 Key 失效', async () => {
    const { service, prisma, probe } = makeService();
    prisma.apiKey.findFirst.mockResolvedValue(row);
    prisma.channelModel.findMany.mockResolvedValue([cmRow]);
    probe.run.mockResolvedValue({
      ok: false,
      status: 401,
      latencyMs: 12,
      model: 'm1-up',
      provider: 'openai',
      error: 'Authentication Fails, Your api key: ****7d65 is invalid',
    });

    const out = await service.test('u1', 'k1', 'm1');

    expect(out).toMatchObject({
      ok: false,
      status: 401,
      error: expect.stringContaining('invalid'),
    });
  });

  it('模型目录已停用 → KEY_TEST_MODEL_DISABLED', async () => {
    const { service, prisma } = makeService();
    prisma.apiKey.findFirst.mockResolvedValue(row);
    prisma.modelCatalog.findFirst.mockResolvedValue({ name: 'm1', enabled: false });

    await expect(service.test('u1', 'k1', 'm1')).resolves.toMatchObject({
      ok: false,
      code: 'KEY_TEST_MODEL_DISABLED',
    });
  });
});
