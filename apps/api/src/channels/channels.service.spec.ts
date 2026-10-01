import { ChannelsService } from './channels.service';
import { PrismaService } from '../prisma/prisma.service';
import { CryptoService } from '../common/crypto.service';
import { ProviderRegistry } from '../gateway/providers/provider.registry';
import { AuthUser } from '../common/interfaces/auth.interface';
import { UpstreamError } from '../gateway/types';
import { GroupsService } from '../groups/groups.service';
import { ChannelOwnerType, Role } from '@prisma/client';

const user: AuthUser = { id: 'u1', email: 'u@t.com', username: 'u', role: Role.USER };

function makeService(providerImpl: any, channelOverrides: Record<string, unknown> = {}) {
  const channel = {
    id: 'c1',
    ownerType: ChannelOwnerType.USER,
    ownerUserId: 'u1',
    name: 'mine',
    provider: 'openai',
    baseUrl: 'https://x/v1',
    apiKeyEnc: 'enc',
    models: ['m1', 'm2'],
    ...channelOverrides,
  };
  const prisma = { channel: { findUnique: jest.fn().mockResolvedValue(channel) } };
  const crypto = { decrypt: jest.fn().mockReturnValue('upstream-key') };
  const providers = { resolve: jest.fn().mockReturnValue(providerImpl) };
  const groups = { effectiveGroup: jest.fn(), channelVisibilityWhere: jest.fn(() => ({})) };
  const service = new ChannelsService(
    prisma as unknown as PrismaService,
    crypto as unknown as CryptoService,
    providers as unknown as ProviderRegistry,
    groups as unknown as GroupsService,
  );
  return { service, providers };
}

describe('ChannelsService.testChannel', () => {
  it('returns ok with latency and sample on success', async () => {
    const provider = {
      chatNonStream: jest.fn().mockResolvedValue({
        status: 200,
        json: { choices: [{ message: { content: 'pong' } }] },
      }),
    };
    const { service, providers } = makeService(provider);
    const res: any = await service.testChannel(user, 'c1', { model: 'm1' });
    expect(res.summary).toEqual({ total: 1, ok: 1, failed: 0 });
    expect(res.results[0].ok).toBe(true);
    expect(res.results[0].status).toBe(200);
    expect(res.results[0].model).toBe('m1');
    expect(res.results[0].sample).toBe('pong');
    expect(typeof res.results[0].latencyMs).toBe('number');
    expect(providers.resolve).toHaveBeenCalledWith('openai');
  });

  it('tests all channel models by default', async () => {
    const provider = { chatNonStream: jest.fn().mockResolvedValue({ status: 200, json: {} }) };
    const { service } = makeService(provider);
    const res: any = await service.testChannel(user, 'c1');
    expect(res.summary.total).toBe(2);
    expect(res.results.map((r: any) => r.model)).toEqual(['m1', 'm2']);
  });

  it('uses the explicitly requested model list', async () => {
    const provider = { chatNonStream: jest.fn().mockResolvedValue({ status: 200, json: {} }) };
    const { service } = makeService(provider);
    const res: any = await service.testChannel(user, 'c1', { models: ['m2'] });
    expect(res.results[0].model).toBe('m2');
    expect(provider.chatNonStream.mock.calls[0][2].model).toBe('m2');
  });

  it('reports upstream error without throwing', async () => {
    const provider = {
      chatNonStream: jest
        .fn()
        .mockRejectedValue(new UpstreamError('bad', 401, false, { error: { message: 'invalid key' } })),
    };
    const { service } = makeService(provider);
    const res: any = await service.testChannel(user, 'c1', { model: 'm1' });
    expect(res.summary).toEqual({ total: 1, ok: 0, failed: 1 });
    expect(res.results[0].ok).toBe(false);
    expect(res.results[0].status).toBe(401);
    expect(res.results[0].error).toBe('invalid key');
  });

  it('rejects when no models to test', async () => {
    const provider = { chatNonStream: jest.fn() };
    const { service } = makeService(provider, { models: [] });
    await expect(service.testChannel(user, 'c1')).rejects.toThrow(/模型名/);
  });

  it('rejects when user does not own the channel', async () => {
    const provider = { chatNonStream: jest.fn() };
    const { service } = makeService(provider, { ownerUserId: 'someone-else' });
    await expect(service.testChannel(user, 'c1')).rejects.toThrow(/not found/);
  });
});

describe('ChannelsService.testConnection', () => {
  it('tests inline config with provided apiKey', async () => {
    const provider = {
      chatNonStream: jest.fn().mockResolvedValue({ status: 200, json: { choices: [{ message: { content: 'pong' } }] } }),
    };
    const { service } = makeService(provider);
    const res: any = await service.testConnection(user, {
      provider: 'openai',
      baseUrl: 'https://new/v1',
      apiKey: 'sk-inline',
      model: 'gpt-x',
    });
    expect(res.summary.ok).toBe(1);
    expect(provider.chatNonStream.mock.calls[0][0].baseUrl).toBe('https://new/v1');
    expect(provider.chatNonStream.mock.calls[0][1]).toBe('sk-inline');
    expect(provider.chatNonStream.mock.calls[0][2].model).toBe('gpt-x');
  });

  it('reuses stored channel key when apiKey omitted', async () => {
    const provider = { chatNonStream: jest.fn().mockResolvedValue({ status: 200, json: {} }) };
    const { service } = makeService(provider);
    const res: any = await service.testConnection(user, {
      provider: 'openai',
      baseUrl: 'https://new/v1',
      channelId: 'c1',
      model: 'gpt-x',
    });
    expect(res.summary.ok).toBe(1);
    expect(provider.chatNonStream.mock.calls[0][1]).toBe('upstream-key');
  });

  it('requires apiKey when no channelId given', async () => {
    const provider = { chatNonStream: jest.fn() };
    const { service } = makeService(provider);
    await expect(
      service.testConnection(user, { provider: 'openai', baseUrl: 'https://x/v1', model: 'm' }),
    ).rejects.toThrow(/API Key/);
  });

  it('requires a model', async () => {
    const provider = { chatNonStream: jest.fn() };
    const { service } = makeService(provider);
    await expect(
      service.testConnection(user, { provider: 'openai', baseUrl: 'https://x/v1', apiKey: 'k' }),
    ).rejects.toThrow(/模型名/);
  });
});

describe('ChannelsService.fetchUpstreamModels', () => {
  const resp = (status: number, json?: unknown, textBody?: string) =>
    ({
      ok: status >= 200 && status < 300,
      status,
      statusText: 'ST',
      json: async () => json,
      text: async () => textBody ?? (json != null ? JSON.stringify(json) : ''),
    }) as unknown as ReturnType<typeof fetch>;

  afterEach(() => jest.restoreAllMocks());

  it('lists openai-compatible models with Bearer auth, deduped and sorted', async () => {
    const { service } = makeService({});
    const spy = jest.spyOn(global, 'fetch').mockResolvedValue(
      resp(200, { data: [{ id: 'gpt-b' }, { id: 'gpt-a' }, { id: 'gpt-a' }] }),
    );
    const res = await service.fetchUpstreamModels(user, {
      provider: 'openai',
      baseUrl: 'https://x/v1',
      apiKey: 'sk-1',
    });
    expect(res.models).toEqual(['gpt-a', 'gpt-b']);
    expect(res.total).toBe(2);
    const [url, init] = spy.mock.calls[0];
    expect(url).toBe('https://x/v1/models');
    expect((init as RequestInit).headers).toMatchObject({
      Authorization: 'Bearer sk-1',
    });
  });

  it('reuses stored baseUrl and key when only channelId given', async () => {
    const { service } = makeService({});
    const spy = jest.spyOn(global, 'fetch').mockResolvedValue(
      resp(200, { data: [{ id: 'm1' }] }),
    );
    const res = await service.fetchUpstreamModels(user, {
      provider: 'openai',
      channelId: 'c1',
    });
    expect(res.models).toEqual(['m1']);
    const [url, init] = spy.mock.calls[0];
    expect(url).toBe('https://x/v1/models'); // 渠道已存 baseUrl
    expect((init as RequestInit).headers).toMatchObject({
      Authorization: 'Bearer upstream-key', // 解密后的已存密钥
    });
  });

  it('falls back to /v1/models when unversioned base returns 404', async () => {
    const { service } = makeService({});
    const spy = jest
      .spyOn(global, 'fetch')
      .mockResolvedValueOnce(resp(404, { error: 'not found' }))
      .mockResolvedValueOnce(resp(200, { data: [{ id: 'm1' }] }));
    const res = await service.fetchUpstreamModels(user, {
      provider: 'openai',
      baseUrl: 'https://x',
      apiKey: 'k',
    });
    expect(res.models).toEqual(['m1']);
    expect(spy.mock.calls[0][0]).toBe('https://x/models');
    expect(spy.mock.calls[1][0]).toBe('https://x/v1/models');
  });

  it('parses gemini models[].name with key in query, drops tuned models', async () => {
    const { service } = makeService({});
    const spy = jest.spyOn(global, 'fetch').mockResolvedValue(
      resp(200, {
        models: [
          { name: 'models/gemini-2.0-flash' },
          { name: 'tunedModels/ft-1' },
          { name: 'models/gemini-1.5-pro' },
        ],
      }),
    );
    const res = await service.fetchUpstreamModels(user, {
      provider: 'gemini',
      baseUrl: 'https://g/v1beta',
      apiKey: 'gk',
    });
    expect(res.models).toEqual(['gemini-1.5-pro', 'gemini-2.0-flash']);
    const [url, init] = spy.mock.calls[0];
    expect(String(url)).toContain('https://g/v1beta/models?pageSize=1000&key=gk');
    expect((init as RequestInit).headers).toEqual({});
  });

  it('surfaces upstream error message on non-2xx', async () => {
    const { service } = makeService({});
    jest.spyOn(global, 'fetch').mockResolvedValue(
      resp(401, null, '{"error":{"message":"Invalid or inactive API key"}}'),
    );
    await expect(
      service.fetchUpstreamModels(user, {
        provider: 'openai',
        baseUrl: 'https://x/v1',
        apiKey: 'bad',
      }),
    ).rejects.toThrow(/上游返回 401: Invalid or inactive API key/);
  });

  it('rejects when upstream returns no models', async () => {
    const { service } = makeService({});
    jest.spyOn(global, 'fetch').mockResolvedValue(resp(200, { data: [] }));
    await expect(
      service.fetchUpstreamModels(user, {
        provider: 'openai',
        baseUrl: 'https://x/v1',
        apiKey: 'k',
      }),
    ).rejects.toThrow(/未返回任何模型/);
  });

  it('requires apiKey when no channelId given', async () => {
    const { service } = makeService({});
    await expect(
      service.fetchUpstreamModels(user, { provider: 'openai', baseUrl: 'https://x/v1' }),
    ).rejects.toThrow(/API Key/);
  });
});

describe('ChannelsService.list（累计共享收益）', () => {
  function listService(rows: any[]) {
    const prisma = {
      channel: {
        findMany: jest.fn().mockResolvedValue(rows),
        count: jest.fn().mockResolvedValue(rows.length),
      },
      requestLog: { groupBy: jest.fn(), findMany: jest.fn(), count: jest.fn() },
    };
    const service = new ChannelsService(
      prisma as unknown as PrismaService,
      { decrypt: jest.fn().mockReturnValue('upstream-key') } as unknown as CryptoService,
      { resolve: jest.fn() } as unknown as ProviderRegistry,
      {} as unknown as GroupsService,
    );
    return { service, prisma };
  }

  const base = { apiKeyEnc: 'enc', priority: 0, weight: 1, models: ['m1'] };

  it('收益读 Channel.shareRevenue（O(1)），不逐 RequestLog 聚合', async () => {
    const { service, prisma } = listService([
      { id: 'c1', ...base, shareRevenue: 1.25 },
      { id: 'c2', ...base, shareRevenue: 0 },
    ]);
    const res = await service.list(user, { page: 1, pageSize: 20 });
    expect(res.items[0].revenue).toBe('1.25');
    expect(res.items[1].revenue).toBe('0');
    expect(res.total).toBe(2);
    // 收益在热路径累加到渠道列上，读侧零额外查询（否则随渠道请求量线性退化）
    expect(prisma.requestLog.groupBy).not.toHaveBeenCalled();
    expect(prisma.requestLog.findMany).not.toHaveBeenCalled();
  });

  it('该列缺省（未回填/旧渠道）时按 0 展示', async () => {
    const { service } = listService([{ id: 'c1', ...base }]);
    const res = await service.list(user, {});
    expect(res.items[0].revenue).toBe('0');
  });
});

describe('ChannelsService.availableModels（归属/共享范围透出）', () => {
  function modelsService(rows: any[]) {
    const prisma = { channelModel: { findMany: jest.fn().mockResolvedValue(rows) } };
    const groups = {
      effectiveGroup: jest.fn().mockResolvedValue({ id: 'g1' }),
      channelScopeWhere: jest.fn().mockReturnValue({ scope: true }),
      isModelVisible: jest.fn().mockReturnValue(true),
    };
    const service = new ChannelsService(
      prisma as unknown as PrismaService,
      {} as unknown as CryptoService,
      {} as unknown as ProviderRegistry,
      groups as unknown as GroupsService,
    );
    return { service, prisma, groups };
  }

  const ch = (over: Record<string, unknown>) => ({
    shareUntil: null,
    shareQuotaCostUsd: null,
    shareQuotaRequests: null,
    shareUsedCostUsd: 0,
    shareUsedRequests: 0,
    ...over,
  });

  it('带出 ownerUserId 与 shareMode，前端据此区分「我的」与「别人共享给我的」', async () => {
    const { service, groups } = modelsService([
      {
        modelName: 'm1',
        channel: ch({ id: 'c1', name: 'mine', ownerType: 'USER', ownerUserId: 'u1', provider: 'openai', shareMode: 'PRIVATE' }),
      },
      {
        modelName: 'm2',
        channel: ch({ id: 'c2', name: 'shared', ownerType: 'USER', ownerUserId: 'u2', provider: 'openai', shareMode: 'PUBLIC' }),
      },
    ]);

    const res = await service.availableModels(user);

    // 可见性仍走 channelScopeWhere 这个唯一出口
    expect(groups.channelScopeWhere).toHaveBeenCalledWith('u1', 'g1');
    expect(res.channels).toHaveLength(2);
    expect(res.channels[0]).toMatchObject({ ownerUserId: 'u1', shareMode: 'PRIVATE' });
    expect(res.channels[1]).toMatchObject({ ownerUserId: 'u2', shareMode: 'PUBLIC' });
    expect(res.models).toEqual(['m1', 'm2']);
  });

  it('共享渠道已用尽额度则不展示', async () => {
    const { service } = modelsService([
      {
        modelName: 'm1',
        channel: ch({
          id: 'c2',
          name: 'done',
          ownerType: 'USER',
          ownerUserId: 'u2',
          provider: 'openai',
          shareMode: 'PUBLIC',
          shareQuotaRequests: 10,
          shareUsedRequests: 10,
        }),
      },
    ]);

    const res = await service.availableModels(user);
    expect(res.channels).toEqual([]);
    expect(res.models).toEqual([]);
  });
});
