import { ChannelResolverService } from './channel-resolver.service';
import { PrismaService } from '../prisma/prisma.service';
import { CryptoService } from '../common/crypto.service';
import { ChannelOwnerType } from '@prisma/client';

function makeChannel(overrides: Record<string, unknown>) {
  return {
    id: String(Math.random()),
    ownerType: ChannelOwnerType.PLATFORM,
    ownerUserId: null,
    name: 'c',
    provider: 'openai',
    baseUrl: 'http://x/v1',
    apiKeyEnc: 'enc',
    models: ['m'],
    weight: 1,
    priority: 0,
    status: 'ENABLED',
    ...overrides,
  } as any;
}

function makeCM(overrides: Record<string, unknown>) {
  return {
    id: String(Math.random()),
    channelId: 'c',
    modelName: 'm',
    enabled: true,
    costInput: null,
    priority: null,
    weight: null,
    channel: makeChannel({}),
    ...overrides,
  } as any;
}

function makeService(rows: any[], decryptImpl?: (s: string) => string) {
  const prisma = {
    channelModel: { findMany: jest.fn().mockResolvedValue(rows) },
    modelCatalog: { findUnique: jest.fn().mockResolvedValue(null) },
  };
  const crypto = {
    decrypt: jest.fn((s: string) => (decryptImpl ? decryptImpl(s) : `key:${s}`)),
  };
  return {
    service: new ChannelResolverService(
      prisma as unknown as PrismaService,
      crypto as unknown as CryptoService,
    ),
    prisma,
  };
}

describe('ChannelResolverService', () => {
  it('prioritizes user BYOK channels over platform channels', async () => {
    const platform = makeCM({
      channel: makeChannel({ id: 'platform', ownerType: ChannelOwnerType.PLATFORM, priority: 999 }),
    });
    const own = makeCM({
      channel: makeChannel({ id: 'own', ownerType: ChannelOwnerType.USER, ownerUserId: 'u1', priority: 0 }),
    });
    const { service } = makeService([platform, own]);
    const result = await service.resolve('u1', 'm');
    expect(result.map((r) => r.channel.id)).toEqual(['own', 'platform']);
  });

  it('orders by priority descending within the same tier', async () => {
    const low = makeCM({ channel: makeChannel({ id: 'low', priority: 1 }) });
    const high = makeCM({ channel: makeChannel({ id: 'high', priority: 10 }) });
    const { service } = makeService([low, high]);
    const result = await service.resolve('u1', 'm');
    expect(result.map((r) => r.channel.id)).toEqual(['high', 'low']);
  });

  it('prefers lower upstream cost within the same priority and tier', async () => {
    const expensive = makeCM({ costInput: 5, channel: makeChannel({ id: 'exp', priority: 0 }) });
    const cheap = makeCM({ costInput: 1, channel: makeChannel({ id: 'cheap', priority: 0 }) });
    const { service } = makeService([expensive, cheap]);
    const result = await service.resolve('u1', 'm');
    expect(result.map((r) => r.channel.id)).toEqual(['cheap', 'exp']);
  });

  it('skips channels that fail to decrypt', async () => {
    const bad = makeCM({ channel: makeChannel({ id: 'bad', apiKeyEnc: 'broken' }) });
    const good = makeCM({ channel: makeChannel({ id: 'good', apiKeyEnc: 'ok' }) });
    const { service } = makeService([bad, good], (s) => {
      if (s === 'broken') throw new Error('nope');
      return 'key';
    });
    const result = await service.resolve('u1', 'm');
    expect(result.map((r) => r.channel.id)).toEqual(['good']);
  });

  it('queries enabled channel-model rows for the model', async () => {
    const { service, prisma } = makeService([]);
    await service.resolve('u1', 'gpt-4o');
    const arg = prisma.channelModel.findMany.mock.calls[0][0];
    expect(arg.where.modelName).toBe('gpt-4o');
    expect(arg.where.enabled).toBe(true);
    expect(arg.where.channel.OR).toHaveLength(2);
  });
});
