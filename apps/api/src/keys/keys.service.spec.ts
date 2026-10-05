import { NotFoundException } from '@nestjs/common';
import { ApiKeyStatus } from '@prisma/client';
import { KeysService } from './keys.service';
import { PrismaService } from '../prisma/prisma.service';
import { CryptoService } from '../common/crypto.service';

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
    // 交互式事务：直接把预置的 tx 交给回调
    $transaction: jest.fn(async (fn: (t: typeof tx) => Promise<unknown>) => fn(tx)),
  };
  const crypto = {
    generateApiKey: jest
      .fn()
      .mockReturnValue({ plaintext: 'sk-plain-xyz', hash: 'HASHED', prefix: 'sk-abc' }),
  };
  const service = new KeysService(
    prisma as unknown as PrismaService,
    crypto as unknown as CryptoService,
  );
  return { service, prisma, tx };
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
      .mockResolvedValueOnce({ id: 'null-bucket'}) // r1：同 (user,date) 已有 NULL 桶
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
