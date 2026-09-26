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

function makeService(channels: any[], decryptImpl?: (s: string) => string) {
  const prisma = { channel: { findMany: jest.fn().mockResolvedValue(channels) } };
  const crypto = {
    decrypt: jest.fn((s: string) => (decryptImpl ? decryptImpl(s) : `key:${s}`)),
  };
  return {
    service: new ChannelResolverService(prisma as unknown as PrismaService, crypto as unknown as CryptoService),
    prisma,
  };
}

describe('ChannelResolverService', () => {
  it('prioritizes user BYOK channels over platform channels', async () => {
    const platform = makeChannel({ id: 'platform', ownerType: ChannelOwnerType.PLATFORM, priority: 999 });
    const own = makeChannel({
      id: 'own',
      ownerType: ChannelOwnerType.USER,
      ownerUserId: 'u1',
      priority: 0,
    });
    const { service } = makeService([platform, own]);
    const result = await service.resolve('u1', 'm');
    expect(result.map((r) => r.channel.id)).toEqual(['own', 'platform']);
  });

  it('orders by priority descending within the same tier', async () => {
    const low = makeChannel({ id: 'low', ownerType: ChannelOwnerType.PLATFORM, priority: 1 });
    const high = makeChannel({ id: 'high', ownerType: ChannelOwnerType.PLATFORM, priority: 10 });
    const { service } = makeService([low, high]);
    const result = await service.resolve('u1', 'm');
    expect(result.map((r) => r.channel.id)).toEqual(['high', 'low']);
  });

  it('skips channels that fail to decrypt', async () => {
    const bad = makeChannel({ id: 'bad', apiKeyEnc: 'broken' });
    const good = makeChannel({ id: 'good', apiKeyEnc: 'ok' });
    const { service } = makeService([bad, good], (s) => {
      if (s === 'broken') throw new Error('nope');
      return 'key';
    });
    const result = await service.resolve('u1', 'm');
    expect(result.map((r) => r.channel.id)).toEqual(['good']);
  });

  it('queries only enabled channels serving the model for the user or platform', async () => {
    const { service, prisma } = makeService([]);
    await service.resolve('u1', 'gpt-4o');
    const arg = prisma.channel.findMany.mock.calls[0][0];
    expect(arg.where.models).toEqual({ has: 'gpt-4o' });
    expect(arg.where.OR).toHaveLength(2);
  });
});
