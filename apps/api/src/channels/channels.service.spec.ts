import { ChannelsService } from './channels.service';
import { PrismaService } from '../prisma/prisma.service';
import { CryptoService } from '../common/crypto.service';
import { ProviderRegistry } from '../gateway/providers/provider.registry';
import { AuthUser } from '../common/interfaces/auth.interface';
import { UpstreamError } from '../gateway/types';
import { GroupsService } from '../groups/groups.service';
import { BadRequestException, ForbiddenException } from '@nestjs/common';
import { ChannelOwnerType, ModelGroupStatus, Role } from '@prisma/client';

const user: AuthUser = { id: 'u1', email: 'u@t.com', username: 'u', role: Role.USER };
const admin: AuthUser = { id: 'a1', email: 'a@t.com', username: 'a', role: Role.ADMIN };

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
  const prisma = {
    channel: { findUnique: jest.fn().mockResolvedValue(channel) },
    modelCatalog: { findFirst: jest.fn().mockResolvedValue(null) },
  };
  const crypto = { decrypt: jest.fn().mockReturnValue('upstream-key') };
  const providers = { resolve: jest.fn().mockReturnValue(providerImpl) };
  const groups = { effectiveGroup: jest.fn(), channelVisibilityWhere: jest.fn(() => ({})) };
  const service = new ChannelsService(
    prisma as unknown as PrismaService,
    crypto as unknown as CryptoService,
    providers as unknown as ProviderRegistry,
    groups as unknown as GroupsService,
  );
  return { service, providers, prisma };
}

/**
 * 构造带交互式事务客户端的 Prisma mock：
 * $transaction(fn) → fn(tx)（模拟 Prisma 交互事务，fn 内抛错 = 整体回滚）；
 * $transaction(ops) → 批量执行（旧的独立批量事务路径）。
 * modelPhaseFails=true 时模型行 upsert 抛错，模拟模型行阶段失败；
 * channel 覆盖渠道行字段（shareUntil / 共享用量等场景）；
 * modelGroups 为 modelGroup.findMany 的返回（分组写前校验用，缺省 = 查不到任何分组）。
 */
function txService(
  opts: {
    modelPhaseFails?: boolean;
    channel?: Record<string, unknown>;
    modelGroups?: { id: string; status: ModelGroupStatus }[];
  } = {},
) {
  const channelRow = {
    id: 'c1',
    ownerType: ChannelOwnerType.USER,
    ownerUserId: 'u1',
    name: 'mine',
    provider: 'openai',
    baseUrl: 'https://x/v1',
    apiKeyEnc: 'enc',
    models: ['m1', 'm2'],
    shareRevenue: 0,
    shareUntil: null as Date | null,
    shareUsedRequests: 0,
    shareUsedCostUsd: 0,
    ...opts.channel,
  };
  const failingUpsert = () => {
    throw new Error('model upsert failed');
  };
  const tx = {
    channel: {
      create: jest.fn().mockResolvedValue(channelRow),
      update: jest.fn().mockResolvedValue(channelRow),
      findUnique: jest.fn().mockResolvedValue({ ...channelRow, modelPrices: [] }),
    },
    channelModel: {
      upsert: opts.modelPhaseFails ? jest.fn(failingUpsert) : jest.fn().mockResolvedValue({}),
      deleteMany: jest.fn().mockResolvedValue({ count: 0 }),
    },
  };
  const prisma = {
    channel: {
      // 事务外的直接写：原子化后绝不允许被调用（这里先给出正常返回值，
      // 以便 RED 断言精确落在「写发生在事务外」而不是 undefined 报错上）
      create: jest.fn().mockResolvedValue(channelRow),
      update: jest.fn().mockResolvedValue(channelRow),
      // findAccessible 权限读（update 走这里，事务外只读不写）
      findUnique: jest.fn().mockResolvedValue(channelRow),
    },
    channelModel: {
      upsert: opts.modelPhaseFails ? jest.fn(failingUpsert) : jest.fn().mockResolvedValue({}),
      deleteMany: jest.fn().mockResolvedValue({ count: 0 }),
    },
    modelGroup: {
      findMany: jest.fn().mockResolvedValue(opts.modelGroups ?? []),
    },
    $transaction: jest.fn(async (arg: unknown) => {
      if (typeof arg === 'function') {
        return (arg as (c: typeof tx) => unknown)(tx);
      }
      return Promise.all(arg as Promise<unknown>[]);
    }),
  };
  const groups = {
    // 本人生效分组（assertGroupsWritable 用）；用例可覆写
    effectiveGroup: jest.fn().mockResolvedValue({ id: 'g1' }),
  };
  const service = new ChannelsService(
    prisma as unknown as PrismaService,
    {
      encrypt: jest.fn().mockReturnValue('enc'),
      decrypt: jest.fn().mockReturnValue('upstream-key'),
    } as unknown as CryptoService,
    {} as unknown as ProviderRegistry,
    // 非管理员写分组权限：默认本人分组 = g1（用例可覆写 mock 返回值）
    groups as unknown as GroupsService,
  );
  return { service, prisma, tx, groups };
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
        .mockRejectedValue(
          new UpstreamError('bad', 401, false, { error: { message: 'invalid key' } }),
        ),
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

  it('probes video models via read-only video status (unknown task = reachable)', async () => {
    const provider = {
      chatNonStream: jest.fn(),
      videoStatus: jest.fn().mockRejectedValue(
        new UpstreamError('Upstream error 404', 404, false, {
          error: { message: 'task_***', code: 'video_task_not_found' },
        }),
      ),
    };
    const { service, prisma } = makeService(provider);
    prisma.modelCatalog.findFirst.mockResolvedValue({ capabilities: ['video'] });
    const res: any = await service.testChannel(user, 'c1', { model: 'm1' });
    expect(res.summary).toEqual({ total: 1, ok: 1, failed: 0 });
    expect(res.results[0].ok).toBe(true);
    expect(String(res.results[0].sample)).toContain('reachable');
    expect(provider.videoStatus).toHaveBeenCalledTimes(1);
    expect(provider.chatNonStream).not.toHaveBeenCalled();
  });

  it('video probe fails on missing endpoint and on connection failure', async () => {
    const provider = {
      chatNonStream: jest.fn(),
      videoStatus: jest
        .fn()
        .mockRejectedValueOnce(
          new UpstreamError('Upstream error 404', 404, false, {
            error: { message: 'This endpoint is not available on the current service node.' },
          }),
        )
        .mockRejectedValueOnce(new UpstreamError('Upstream connection failed: timeout', 502, true)),
    };
    const { service, prisma } = makeService(provider);
    prisma.modelCatalog.findFirst.mockResolvedValue({ capabilities: ['video'] });
    const first: any = await service.testChannel(user, 'c1', { model: 'm1' });
    expect(first.summary).toEqual({ total: 1, ok: 0, failed: 1 });
    expect(first.results[0].status).toBe(404);
    expect(first.results[0].error).toContain('endpoint');
    const second: any = await service.testChannel(user, 'c1', { model: 'm1' });
    expect(second.results[0].ok).toBe(false);
    expect(second.results[0].status).toBe(502);
  });

  it('falls back to chat probe when provider has no videoStatus', async () => {
    const provider = { chatNonStream: jest.fn().mockResolvedValue({ status: 200, json: {} }) };
    const { service, prisma } = makeService(provider);
    prisma.modelCatalog.findFirst.mockResolvedValue({ capabilities: ['video'] });
    const res: any = await service.testChannel(user, 'c1', { model: 'm1' });
    expect(res.summary).toEqual({ total: 1, ok: 1, failed: 0 });
    expect(provider.chatNonStream).toHaveBeenCalled();
  });

  it('redacts upstream-echoed secrets in error and detail', async () => {
    const provider = {
      chatNonStream: jest.fn().mockRejectedValue(
        new UpstreamError('Upstream error 401', 401, false, {
          error: {
            message:
              'token 无效：sk-e280214426a3926f9da9b1101da475c7419cabd0659c1b0a61f251362f10a0fe',
          },
        }),
      ),
    };
    const { service } = makeService(provider);
    const res: any = await service.testChannel(user, 'c1', { model: 'm1' });
    expect(res.results[0].error).toContain('sk-***');
    expect(res.results[0].error).not.toContain('sk-e280214426');
    expect(String(res.results[0].detail)).toContain('sk-***');
    expect(String(res.results[0].detail)).not.toContain('sk-e280214426');
  });
});

describe('ChannelsService.testConnection', () => {
  it('tests inline config with provided apiKey', async () => {
    const provider = {
      chatNonStream: jest
        .fn()
        .mockResolvedValue({ status: 200, json: { choices: [{ message: { content: 'pong' } }] } }),
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
    const spy = jest
      .spyOn(global, 'fetch')
      .mockResolvedValue(resp(200, { data: [{ id: 'gpt-b' }, { id: 'gpt-a' }, { id: 'gpt-a' }] }));
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
    const spy = jest.spyOn(global, 'fetch').mockResolvedValue(resp(200, { data: [{ id: 'm1' }] }));
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
    jest
      .spyOn(global, 'fetch')
      .mockResolvedValue(resp(401, null, '{"error":{"message":"Invalid or inactive API key"}}'));
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

describe('ChannelsService.create/update（渠道行+模型行同一事务，失败不残留半份配置）', () => {
  const createDto = {
    name: 'mine',
    provider: 'openai',
    baseUrl: 'https://x/v1',
    apiKey: 'sk-upstream',
    models: ['m1', 'm2'],
  };

  it('create：模型行阶段失败时失败向外传播，渠道行绝不在事务外落库', async () => {
    const { service, prisma } = txService({ modelPhaseFails: true });

    // 失败必须传播（不吞错）
    await expect(service.create(user, createDto)).rejects.toThrow('model upsert failed');

    // 渠道行 + 模型行 + 终读必须全部发生在同一个交互式事务里：
    // 若 channel.create 在事务外被直接调用，失败后会残留半份配置（无渠道行/有渠道行无模型行）
    expect(prisma.$transaction).toHaveBeenCalledWith(expect.any(Function));
    expect(prisma.channel.create).not.toHaveBeenCalled();
    expect(prisma.channel.findUnique).not.toHaveBeenCalled();
  });

  it('create：成功时渠道行/模型行/终读都走同一交互事务并返回视图', async () => {
    const { service, prisma, tx } = txService();

    const res = (await service.create(user, createDto)) as Record<string, unknown>;

    expect(prisma.$transaction).toHaveBeenCalledWith(expect.any(Function));
    expect(tx.channel.create).toHaveBeenCalledTimes(1);
    expect(tx.channelModel.upsert).toHaveBeenCalled();
    expect(tx.channel.findUnique).toHaveBeenCalledTimes(1);
    // 事务外没有任何直接写/终读
    expect(prisma.channel.create).not.toHaveBeenCalled();
    expect(prisma.channel.findUnique).not.toHaveBeenCalled();
    expect(res.id).toBe('c1');
    expect(res.apiKeyPreview).toBe('****-key');
  });

  it('update：模型行阶段失败时失败向外传播，渠道行更新绝不在事务外执行', async () => {
    const { service, prisma } = txService({ modelPhaseFails: true });

    await expect(service.update(user, 'c1', { models: ['m1'] })).rejects.toThrow(
      'model upsert failed',
    );

    expect(prisma.$transaction).toHaveBeenCalledWith(expect.any(Function));
    expect(prisma.channel.update).not.toHaveBeenCalled();
  });

  it('update：成功时更新/模型行 prune/终读都走同一交互事务', async () => {
    const { service, prisma, tx } = txService();

    const res = (await service.update(user, 'c1', { models: ['m1'] })) as Record<string, unknown>;

    expect(prisma.$transaction).toHaveBeenCalledWith(expect.any(Function));
    expect(tx.channel.update).toHaveBeenCalledTimes(1);
    expect(tx.channelModel.upsert).toHaveBeenCalled();
    expect(tx.channelModel.deleteMany).toHaveBeenCalled(); // models 传了 → prune
    expect(tx.channel.findUnique).toHaveBeenCalledTimes(1);
    expect(prisma.channel.update).not.toHaveBeenCalled();
    expect(res.id).toBe('c1');
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
        channel: ch({
          id: 'c1',
          name: 'mine',
          ownerType: 'USER',
          ownerUserId: 'u1',
          provider: 'openai',
          shareMode: 'PRIVATE',
        }),
      },
      {
        modelName: 'm2',
        channel: ch({
          id: 'c2',
          name: 'shared',
          ownerType: 'USER',
          ownerUserId: 'u2',
          provider: 'openai',
          shareMode: 'PUBLIC',
        }),
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

describe('ChannelsService.update 共享用量重置（resetShareUsed / shareUntil 延长）', () => {
  const shareChannel = {
    shareUntil: new Date('2026-06-01T00:00:00.000Z'),
    shareUsedRequests: 10,
    shareUsedCostUsd: 1.25,
    shareRevenue: 3.5,
  };
  const later = '2026-07-01T00:00:00.000Z';
  const earlier = '2026-05-01T00:00:00.000Z';

  it('resetShareUsed=true → 清零已用次数与已用成本，绝不动 shareRevenue', async () => {
    const { service, tx } = txService({ channel: shareChannel });

    await service.update(user, 'c1', { resetShareUsed: true });

    const data = tx.channel.update.mock.calls[0][0].data;
    expect(data.shareUsedRequests).toBe(0);
    expect(data.shareUsedCostUsd).toBe(0);
    expect(data.shareRevenue).toBeUndefined();
  });

  it('shareUntil 延长（严格晚于旧值）→ 同时清零已用次数与已用成本', async () => {
    const { service, tx } = txService({ channel: shareChannel });

    await service.update(user, 'c1', { shareUntil: later });

    const data = tx.channel.update.mock.calls[0][0].data;
    expect(data.shareUsedRequests).toBe(0);
    expect(data.shareUsedCostUsd).toBe(0);
    expect(data.shareRevenue).toBeUndefined();
  });

  it('shareUntil 缩短 → 不清零', async () => {
    const { service, tx } = txService({ channel: shareChannel });

    await service.update(user, 'c1', { shareUntil: earlier });

    const data = tx.channel.update.mock.calls[0][0].data;
    expect(data.shareUsedRequests).toBeUndefined();
    expect(data.shareUsedCostUsd).toBeUndefined();
  });

  it('shareUntil 与旧值相同 → 不清零', async () => {
    const { service, tx } = txService({ channel: shareChannel });

    await service.update(user, 'c1', { shareUntil: shareChannel.shareUntil.toISOString() });

    const data = tx.channel.update.mock.calls[0][0].data;
    expect(data.shareUsedRequests).toBeUndefined();
    expect(data.shareUsedCostUsd).toBeUndefined();
  });

  it('shareUntil 置 null（清除到期时间）→ 不清零', async () => {
    const { service, tx } = txService({ channel: shareChannel });

    await service.update(user, 'c1', { shareUntil: null });

    const data = tx.channel.update.mock.calls[0][0].data;
    expect(data.shareUsedRequests).toBeUndefined();
    expect(data.shareUsedCostUsd).toBeUndefined();
  });

  it('未传 shareUntil（其它字段更新）→ 不清零', async () => {
    const { service, tx } = txService({ channel: shareChannel });

    await service.update(user, 'c1', { name: 'renamed' });

    const data = tx.channel.update.mock.calls[0][0].data;
    expect(data.shareUsedRequests).toBeUndefined();
    expect(data.shareUsedCostUsd).toBeUndefined();
  });

  it('旧渠道无到期时间（null）→ 即使新传了时间也不清零', async () => {
    const { service, tx } = txService({
      channel: {
        shareUntil: null,
        shareUsedRequests: 10,
        shareUsedCostUsd: 1.25,
        shareRevenue: 3.5,
      },
    });

    await service.update(user, 'c1', { shareUntil: later });

    const data = tx.channel.update.mock.calls[0][0].data;
    expect(data.shareUsedRequests).toBeUndefined();
    expect(data.shareUsedCostUsd).toBeUndefined();
  });

  it('resetShareUsed 与 shareUntil 延长同时命中 → 单次 update 内一次清零（不双写）', async () => {
    const { service, tx } = txService({ channel: shareChannel });

    await service.update(user, 'c1', { resetShareUsed: true, shareUntil: later });

    expect(tx.channel.update).toHaveBeenCalledTimes(1);
    const data = tx.channel.update.mock.calls[0][0].data;
    expect(data.shareUsedRequests).toBe(0);
    expect(data.shareUsedCostUsd).toBe(0);
    expect(data.shareRevenue).toBeUndefined();
  });
});

describe('ChannelsService 分组绑定（写前存在性校验 + 非管理员仅限本人分组）', () => {
  const baseDto = {
    name: 'mine',
    provider: 'openai',
    baseUrl: 'https://x/v1',
    apiKey: 'sk-upstream',
    models: ['m1', 'm2'],
  };
  const gEnabled = { id: 'g1', status: ModelGroupStatus.ENABLED };
  const gDisabled = { id: 'g1', status: ModelGroupStatus.DISABLED };

  it('create：管理员可绑任意分组，写前批量校验只查一次', async () => {
    const { service, prisma, tx } = txService({
      modelGroups: [gEnabled, { id: 'g2', status: ModelGroupStatus.ENABLED }],
    });

    await service.create(admin, { ...baseDto, groups: ['g1', 'g2'] });

    expect(prisma.modelGroup.findMany).toHaveBeenCalledTimes(1);
    expect(prisma.modelGroup.findMany).toHaveBeenCalledWith(
      expect.objectContaining({ where: { id: { in: ['g1', 'g2'] } } }),
    );
    const data = tx.channel.create.mock.calls[0][0].data;
    expect(data.groups).toEqual({ connect: [{ id: 'g1' }, { id: 'g2' }] });
  });

  it('create：非管理员仅可绑本人分组（默认 g1）→ 落库 connect', async () => {
    const { service, tx } = txService({ modelGroups: [gEnabled] });

    await service.create(user, { ...baseDto, groups: ['g1'] });

    const data = tx.channel.create.mock.calls[0][0].data;
    expect(data.groups).toEqual({ connect: [{ id: 'g1' }] });
  });

  it('create：非管理员绑他人分组 → Forbidden，事务不启动', async () => {
    const { service, prisma, tx } = txService({
      modelGroups: [gEnabled, { id: 'g2', status: ModelGroupStatus.ENABLED }],
    });

    const act = () => service.create(user, { ...baseDto, groups: ['g2'] });
    await expect(act()).rejects.toBeInstanceOf(ForbiddenException);
    await expect(act()).rejects.toThrow('非管理员仅可绑定本人所在分组: g2');

    expect(prisma.$transaction).not.toHaveBeenCalled();
    expect(tx.channel.create).not.toHaveBeenCalled();
  });

  it('create：分组不存在 → BadRequest，事务与渠道写全部不发生', async () => {
    const { service, prisma, tx } = txService({ modelGroups: [gEnabled] });

    const act = () => service.create(user, { ...baseDto, groups: ['g1', 'g2'] });
    await expect(act()).rejects.toBeInstanceOf(BadRequestException);
    await expect(act()).rejects.toThrow('分组不存在或已停用: g2');

    expect(prisma.$transaction).not.toHaveBeenCalled();
    expect(tx.channel.create).not.toHaveBeenCalled();
    expect(prisma.channel.create).not.toHaveBeenCalled();
  });

  it('create：分组已停用 → BadRequest，事务不启动', async () => {
    const { service, prisma, tx } = txService({ modelGroups: [gDisabled] });

    await expect(service.create(user, { ...baseDto, groups: ['g1'] })).rejects.toThrow(
      '分组不存在或已停用: g1',
    );

    expect(prisma.$transaction).not.toHaveBeenCalled();
    expect(tx.channel.create).not.toHaveBeenCalled();
    expect(prisma.channel.create).not.toHaveBeenCalled();
  });

  it('update：分组已停用 → BadRequest，事务与更新全部不发生', async () => {
    const { service, prisma, tx } = txService({ modelGroups: [gDisabled] });

    await expect(service.update(user, 'c1', { groups: ['g1'] })).rejects.toThrow(
      '分组不存在或已停用: g1',
    );

    expect(prisma.$transaction).not.toHaveBeenCalled();
    expect(tx.channel.update).not.toHaveBeenCalled();
    expect(prisma.channel.update).not.toHaveBeenCalled();
  });

  it('update：非管理员改绑本人分组 → 写前校验一次并写入 set', async () => {
    const { service, prisma, tx } = txService({ modelGroups: [gEnabled] });

    await service.update(user, 'c1', { groups: ['g1'] });

    expect(prisma.modelGroup.findMany).toHaveBeenCalledTimes(1);
    const data = tx.channel.update.mock.calls[0][0].data;
    expect(data.groups).toEqual({ set: [{ id: 'g1' }] });
  });

  it('update：非管理员引入他人分组 → Forbidden，事务不启动', async () => {
    const { service, prisma, tx } = txService({
      modelGroups: [gEnabled, { id: 'g2', status: ModelGroupStatus.ENABLED }],
    });

    await expect(service.update(user, 'c1', { groups: ['g2'] })).rejects.toBeInstanceOf(
      ForbiddenException,
    );

    expect(prisma.$transaction).not.toHaveBeenCalled();
    expect(tx.channel.update).not.toHaveBeenCalled();
  });

  it('update：历史外组绑定原样回传（与现值一致）→ 放行且不查本人生效分组', async () => {
    const { service, groups, tx } = txService({
      channel: { groups: [{ id: 'gx' }] },
      modelGroups: [{ id: 'gx', status: ModelGroupStatus.ENABLED }],
    });

    await service.update(user, 'c1', { groups: ['gx'] });

    expect(groups.effectiveGroup).not.toHaveBeenCalled();
    const data = tx.channel.update.mock.calls[0][0].data;
    expect(data.groups).toEqual({ set: [{ id: 'gx' }] });
  });

  it('update：groups 未传 → 不改绑定也不触发校验', async () => {
    const { service, prisma, tx } = txService();

    await service.update(user, 'c1', { name: 'renamed' });

    expect(prisma.modelGroup.findMany).not.toHaveBeenCalled();
    const data = tx.channel.update.mock.calls[0][0].data;
    expect(data.groups).toBeUndefined();
  });

  it('update：groups=[] → 清空绑定（set: []），空数组不触发校验', async () => {
    const { service, prisma, tx } = txService();

    await service.update(user, 'c1', { groups: [] });

    expect(prisma.modelGroup.findMany).not.toHaveBeenCalled();
    const data = tx.channel.update.mock.calls[0][0].data;
    expect(data.groups).toEqual({ set: [] });
  });
});
