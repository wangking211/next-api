import { UsageService, UsageEntry } from './usage.service';
import { PrismaService } from '../prisma/prisma.service';
import { BillingService } from '../billing/billing.service';
import { ConfigService } from '@nestjs/config';
import { Prisma, Role } from '@prisma/client';

/**
 * 计费口径：
 * - chargeable=true（平台渠道）→ 扣余额、累计 Key 费用额度与 UsageDaily.billedCost
 * - chargeable=false（用户自有 BYOK）→ 一律不扣，只写明细与折算金额
 */
function makeService() {
  const tx = {
    requestLog: { create: jest.fn().mockResolvedValue({ id: 'log1' }) },
    apiKey: { update: jest.fn().mockResolvedValue({}) },
  };
  const prisma = {
    $transaction: (cb: any) => cb(tx),
    usageDaily: {
      create: jest.fn().mockResolvedValue({}),
      updateMany: jest.fn().mockResolvedValue({ count: 0 }),
    },
    user: { updateMany: jest.fn().mockResolvedValue({}) },
    requestLog: {
      findMany: jest.fn().mockResolvedValue([]),
      count: jest.fn().mockResolvedValue(0),
      // 幂等判定用（billingCommitted）：默认 null = 未落账，按「可重试」处理
      findUnique: jest.fn().mockResolvedValue(null),
    },
  };
  const billing = {
    getChannelPricing: jest.fn().mockResolvedValue({
      priceInput: 1,
      priceOutput: 2,
      cacheReadPrice: 0,
      cacheWritePrice: 0,
      costInput: 0.4,
      costOutput: 0.8,
      cacheReadCost: 0,
      cacheWriteCost: 0,
    }),
    getUserMultiplier: jest.fn().mockResolvedValue(1),
    recordConsumption: jest.fn().mockResolvedValue(0),
  };
  const config = { get: (_k: string, d?: unknown) => d };
  const service = new UsageService(
    prisma as unknown as PrismaService,
    billing as unknown as BillingService,
    config as unknown as ConfigService,
  );
  return { service, tx, prisma, billing };
}

const baseEntry: UsageEntry = {
  userId: 'user1',
  apiKeyId: 'k1',
  channelId: 'ch1',
  model: 'gpt-4o',
  provider: 'openai',
  promptTokens: 1_000_000,
  completionTokens: 0,
  totalTokens: 1_000_000,
  latencyMs: 12,
  status: 200,
  isStream: false,
  requestPreview: '',
  responsePreview: '',
};

describe('UsageService 计费口径', () => {
  it('BYOK 调用不扣余额、不消耗费用额度，但照常写明细与折算金额', async () => {
    const { service, tx, prisma, billing } = makeService();

    await service.record({ ...baseEntry, chargeable: false });

    expect(billing.recordConsumption).not.toHaveBeenCalled();
    expect(tx.requestLog.create).toHaveBeenCalledWith({
      data: expect.objectContaining({ chargeable: false, cost: 1 }),
    });
    // 费用额度不被免费调用消耗
    expect(tx.apiKey.update).toHaveBeenCalledWith({
      where: { id: 'k1' },
      data: expect.objectContaining({
        quotaUsed: { increment: 1_000_000 },
        costUsed: { increment: 0 },
      }),
    });
    // 日聚合：折算总额照记，实扣为 0
    expect(prisma.usageDaily.create).toHaveBeenCalledWith({
      data: expect.objectContaining({ cost: 1, billedCost: 0 }),
    });
    // 无论是否扣费都刷新「最后活跃」
    expect(prisma.user.updateMany).toHaveBeenCalledTimes(1);
  });

  it('平台渠道调用扣余额并累计 billedCost 与费用额度', async () => {
    const { service, tx, prisma, billing } = makeService();

    await service.record({ ...baseEntry, chargeable: true });

    expect(billing.recordConsumption).toHaveBeenCalledWith(
      expect.anything(),
      'user1',
      1,
      'log1',
      '调用 gpt-4o',
      expect.anything(),
    );
    expect(tx.requestLog.create).toHaveBeenCalledWith({
      data: expect.objectContaining({ chargeable: true, cost: 1 }),
    });
    expect(tx.apiKey.update).toHaveBeenCalledWith({
      where: { id: 'k1' },
      data: expect.objectContaining({ costUsed: { increment: 1 } }),
    });
    expect(prisma.usageDaily.create).toHaveBeenCalledWith({
      data: expect.objectContaining({ cost: 1, billedCost: 1 }),
    });
  });

  it('chargeable 未显式传入时不扣费（与余额扣款保持同口径）', async () => {
    const { service, billing } = makeService();

    await service.record({ ...baseEntry });

    expect(billing.recordConsumption).not.toHaveBeenCalled();
  });

  it('落账后刷新「最后活跃」，且带 5 分钟陈旧阈值（避免热路径每请求写行）', async () => {
    const { service, prisma } = makeService();

    await service.record({ ...baseEntry, chargeable: true });

    expect(prisma.user.updateMany).toHaveBeenCalledTimes(1);
    const arg = prisma.user.updateMany.mock.calls[0][0];
    expect(arg.where.id).toBe('user1');
    expect(arg.where.OR[0]).toEqual({ lastActiveAt: null });
    expect(arg.where.OR[1].lastActiveAt.lt).toBeInstanceOf(Date);
    expect(arg.data.lastActiveAt).toBeInstanceOf(Date);
  });

  it('活跃时间写入失败静默，不影响计费主流程', async () => {
    const { service, prisma, billing } = makeService();
    prisma.user.updateMany.mockRejectedValueOnce(new Error('db down'));

    await expect(service.record({ ...baseEntry, chargeable: true })).resolves.toBeUndefined();

    expect(billing.recordConsumption).toHaveBeenCalled();
    expect(prisma.usageDaily.create).toHaveBeenCalled();
  });

  it('日聚合 updateMany-first：已存在行时直接自增，不再 create', async () => {
    const { service, prisma } = makeService();
    prisma.usageDaily.updateMany.mockResolvedValueOnce({ count: 1 });

    await service.record({ ...baseEntry, chargeable: true });

    expect(prisma.usageDaily.create).not.toHaveBeenCalled();
    expect(prisma.usageDaily.updateMany).toHaveBeenCalledTimes(1);
    expect(prisma.usageDaily.updateMany).toHaveBeenCalledWith({
      where: { userId: 'user1', apiKeyId: 'k1', date: expect.any(Date) },
      data: expect.objectContaining({ requests: { increment: 1 } }),
    });
  });

  it('日聚合 create 撞唯一约束（并发首写）时回退 updateMany 自增', async () => {
    const { service, prisma } = makeService();
    prisma.usageDaily.create.mockRejectedValueOnce(
      new Prisma.PrismaClientKnownRequestError(
        'Unique constraint failed on the fields: (`userId`,`apiKeyId`,`date`)',
        {
          code: 'P2002',
          clientVersion: '6.2.1',
        },
      ),
    );

    await service.record({ ...baseEntry, chargeable: true });

    // 首次 updateMany 命中 0 行 → create → P2002 → 再 updateMany 自增
    expect(prisma.usageDaily.updateMany).toHaveBeenCalledTimes(2);
    expect(prisma.usageDaily.create).toHaveBeenCalledTimes(1);
  });

  it('进程内节流：5 分钟内同一用户只写一次 lastActiveAt', async () => {
    const { service, prisma } = makeService();

    await service.record({ ...baseEntry, chargeable: true });
    await service.record({ ...baseEntry, chargeable: true });
    await service.record({ ...baseEntry, chargeable: true });

    expect(prisma.user.updateMany).toHaveBeenCalledTimes(1);
  });

  it('不同用户各自节流（互不干扰）', async () => {
    const { service, prisma } = makeService();

    await service.record({ ...baseEntry, chargeable: true });
    await service.record({ ...baseEntry, userId: 'user2', chargeable: true });

    expect(prisma.user.updateMany).toHaveBeenCalledTimes(2);
  });
});

/**
 * 共享分成落账：钱进渠道主余额的同时，累计值也要闭环到 Channel.shareRevenue
 * ——渠道列表读「收益」走这一列（O(1)），不逐 RequestLog 聚合。
 */
describe('UsageService 共享分成落账', () => {
  function shareSetup() {
    const ctx = makeService();
    const tx = ctx.tx as any;
    const billing = ctx.billing as any;
    tx.channel = { update: jest.fn().mockResolvedValue({}) };
    tx.requestLog.update = jest.fn().mockResolvedValue({});
    // 足额扣款（paid.debited = cost）才分成
    billing.recordConsumption = jest.fn().mockImplementation(async (...args: any[]) => {
      args[5].debited = args[2];
      return 0;
    });
    billing.payChannelRevenue = jest.fn().mockResolvedValue(0.8);
    return { ...ctx, tx, billing };
  }

  const shareEntry: UsageEntry = {
    ...baseEntry,
    chargeable: true,
    share: { ownerUserId: 'owner1', feeBps: 2000 },
  };

  it('收益写入 RequestLog.channelRevenue，并同事务累加 Channel.shareRevenue', async () => {
    const { service, tx, billing } = shareSetup();

    await service.record(shareEntry);

    expect(billing.payChannelRevenue).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ ownerUserId: 'owner1', feeBps: 2000 }),
    );
    expect(tx.requestLog.update).toHaveBeenCalledWith({
      where: { id: 'log1' },
      data: expect.objectContaining({ channelRevenue: 0.8 }),
    });
    expect(tx.channel.update).toHaveBeenCalledWith({
      where: { id: 'ch1' },
      data: expect.objectContaining({
        shareUsedRequests: { increment: 1 },
        shareRevenue: { increment: 0.8 },
      }),
    });
  });

  it('分成为 0 时不写 shareRevenue 增量，但共享用量照常累计', async () => {
    const { service, tx, billing } = shareSetup();
    billing.payChannelRevenue.mockResolvedValue(0);

    await service.record(shareEntry);

    expect(tx.requestLog.update).not.toHaveBeenCalled();
    expect(tx.channel.update).toHaveBeenCalledWith({
      where: { id: 'ch1' },
      data: expect.objectContaining({ shareUsedRequests: { increment: 1 } }),
    });
    expect(tx.channel.update.mock.calls[0][0].data.shareRevenue).toBeUndefined();
  });
});

/**
 * 计费事务瞬时失败：整体重试一次且重试幂等——RequestLog 主键在 record() 开始时
 * 预生成，行存在 = 已完整落账（「提交响应丢失」不重试也不误报）；确认未落账才重放
 * （同键重放撞主键即停，绝无二次扣费）。
 * 两次都失败且确认未落账才记 logger.error 并返回——record() 永不抛出（HTTP 响应已发给调用方）。
 */
describe('UsageService 计费事务重试', () => {
  it('$transaction 首次失败、重试成功：事务共尝试两次，日聚合等下游照常执行', async () => {
    const { service, prisma, tx } = makeService();
    prisma.$transaction = jest
      .fn()
      .mockRejectedValueOnce(new Error('transient db hiccup'))
      .mockImplementationOnce((cb: any) => cb(tx));
    const errSpy = jest.spyOn(service['logger'], 'error');

    await expect(service.record({ ...baseEntry, chargeable: true })).resolves.toBeUndefined();

    expect(prisma.$transaction).toHaveBeenCalledTimes(2);
    // 重试成功后下游照常：日聚合 + 刷新最后活跃
    expect(prisma.usageDaily.create).toHaveBeenCalledTimes(1);
    expect(prisma.user.updateMany).toHaveBeenCalledTimes(1);
    // 只有一次失败时不该出现「用量记录失败」告警
    expect(errSpy).not.toHaveBeenCalled();
    errSpy.mockRestore();
  });

  it('$transaction 两次都失败：只记一次 logger.error，record() 不抛出且不再重试', async () => {
    const { service, prisma } = makeService();
    prisma.$transaction = jest.fn().mockRejectedValue(new Error('db down'));
    const errSpy = jest.spyOn(service['logger'], 'error');

    await expect(service.record({ ...baseEntry, chargeable: true })).resolves.toBeUndefined();

    // 有界重试：总共恰好两次尝试，绝不无限循环
    expect(prisma.$transaction).toHaveBeenCalledTimes(2);
    expect(errSpy).toHaveBeenCalledTimes(1);
    // 事务全失败 → 不做日聚合（计费未落库，避免半截数据）
    expect(prisma.usageDaily.create).not.toHaveBeenCalled();
    errSpy.mockRestore();
  });

  it('首次失败但已确认落账（提交响应丢失）→ 不重试、不告警、下游照常', async () => {
    const { service, prisma } = makeService();
    prisma.$transaction = jest.fn().mockRejectedValue(new Error('connection reset at commit'));
    // 预生成主键的行已存在 = 首次尝试实际已提交
    prisma.requestLog.findUnique = jest.fn().mockResolvedValue({ id: 'logId' });
    const errSpy = jest.spyOn(service['logger'], 'error');

    await expect(service.record({ ...baseEntry, chargeable: true })).resolves.toBeUndefined();

    expect(prisma.$transaction).toHaveBeenCalledTimes(1); // 已落账 → 绝不重试
    expect(errSpy).not.toHaveBeenCalled();
    expect(prisma.usageDaily.create).toHaveBeenCalledTimes(1); // 视为成功，聚合照常
    errSpy.mockRestore();
  });

  it('重试沿用同一预生成主键（重放撞键即已提交，绝无二次扣费）', async () => {
    const { service, prisma, tx } = makeService();
    // 首次尝试：事务体执行完后在提交阶段丢响应（模拟已提交但客户端收到错误）
    prisma.$transaction = jest
      .fn()
      .mockImplementationOnce(async (cb: any) => {
        await cb(tx);
        throw new Error('commit response lost');
      })
      .mockImplementationOnce((cb: any) => cb(tx));
    prisma.requestLog.findUnique = jest.fn().mockResolvedValue(null); // 首次已回滚判定

    await expect(service.record({ ...baseEntry, chargeable: true })).resolves.toBeUndefined();

    expect(prisma.$transaction).toHaveBeenCalledTimes(2);
    const ids = tx.requestLog.create.mock.calls.map((c: any) => c[0].data.id);
    expect(ids).toHaveLength(2);
    expect(ids[0]).toBe(ids[1]); // 两次尝试同键 → 真实 PG 中重放会撞主键而非双写
    expect(typeof ids[0]).toBe('string');
    expect(ids[0].length).toBeGreaterThan(0);
  });

  it('重试尝试也「提交后丢响应」→ 二次确认落账 → 视为成功、仅 warn 不 error', async () => {
    const { service, prisma } = makeService();
    prisma.$transaction = jest.fn().mockRejectedValue(new Error('commit response lost'));
    prisma.requestLog.findUnique = jest
      .fn()
      .mockResolvedValueOnce(null) // 重试前：确认首次确实回滚
      .mockResolvedValueOnce({ id: 'logId' }); // 二次失败后：确认重试实际已提交
    const errSpy = jest.spyOn(service['logger'], 'error');
    const warnSpy = jest.spyOn(service['logger'], 'warn');

    await expect(service.record({ ...baseEntry, chargeable: true })).resolves.toBeUndefined();

    expect(prisma.$transaction).toHaveBeenCalledTimes(2);
    expect(errSpy).not.toHaveBeenCalled(); // 落账成功，绝不误报计费丢失
    expect(warnSpy).toHaveBeenCalledTimes(1);
    expect(prisma.usageDaily.create).toHaveBeenCalledTimes(1);
    errSpy.mockRestore();
    warnSpy.mockRestore();
  });
});

/**
 * 越权回归：日志查询的 userId 过滤绝不能覆盖属主约束
 * （曾因 controller 把 targetUserId 放进 query、service 展开在 scope 之后而可读他人日志）。
 */
describe('UsageService 日志查询属主约束', () => {
  it('非管理员指定他人 userId 时仍按自己的 userId 过滤', async () => {
    const { service, prisma } = makeService();

    await service.logs('user1', { targetUserId: 'victim-user' });

    const where = prisma.requestLog.findMany.mock.calls[0][0].where;
    expect(where.userId).toBe('user1');
    expect(prisma.requestLog.count).toHaveBeenCalledWith({
      where: expect.objectContaining({ userId: 'user1' }),
    });
  });

  it('管理员（scope=all，userId 为 null）才可按 userId 过滤', async () => {
    const { service, prisma } = makeService();

    await service.logs(null, { targetUserId: 'user2' });

    const where = prisma.requestLog.findMany.mock.calls[0][0].where;
    expect(where.userId).toBe('user2');
  });

  it('管理员未指定 userId 时不加 userId 条件', async () => {
    const { service, prisma } = makeService();

    await service.logs(null, {});

    const where = prisma.requestLog.findMany.mock.calls[0][0].where;
    expect(where.userId).toBeUndefined();
  });

  it('关键词过滤与属主约束同时生效（内容推断也拿不到他人数据）', async () => {
    const { service, prisma } = makeService();

    await service.logs('user1', { targetUserId: 'victim-user', q: 'secret' });

    const where = prisma.requestLog.findMany.mock.calls[0][0].where;
    expect(where.userId).toBe('user1');
    expect(where.OR).toHaveLength(3);
  });
});

describe('UsageService 日志 Token 明细（缓存读/写）', () => {
  it('列表 select 带 cacheReadTokens / cacheWriteTokens（列表拆分展示用）', async () => {
    const { service, prisma } = makeService();

    await service.logs('user1', {});

    const select = prisma.requestLog.findMany.mock.calls[0][0].select;
    expect(select.cacheReadTokens).toBe(true);
    expect(select.cacheWriteTokens).toBe(true);
    expect(select.totalTokens).toBe(true);
  });

  it('导出 CSV 末尾追加缓存读/写 tokens 列，既有列序不变', async () => {
    const { service, prisma } = makeService();
    prisma.requestLog.findMany.mockResolvedValue([
      {
        createdAt: new Date('2026-11-06T09:00:00Z'),
        model: 'deepseek-v4-flash',
        provider: 'deepseek',
        isStream: true,
        promptTokens: 100,
        completionTokens: 20,
        cacheReadTokens: 64,
        cacheWriteTokens: 8,
        totalTokens: 120,
        cost: '0.000120',
        chargeable: true,
        commission: '0',
        latencyMs: 850,
        status: 200,
        errorMessage: null,
        upstreamRequestId: 'req-1',
        apiKey: { name: 'k' },
        channel: { name: 'ch' },
      },
    ]);

    const csv = await service.exportLogs('user1', {});
    const [header, row] = csv.split('\n');

    expect(header).toContain('输入tokens,输出tokens,总tokens');
    expect(header.endsWith(',缓存读tokens,缓存写tokens')).toBe(true);
    expect(row.endsWith(',64,8')).toBe(true);
  });
});

describe('UsageService.reconciliationCsv（渠道×日对账导出）', () => {
  const RAW_ROW = {
    day: '2026-11-03',
    channel: 'deepseekForWangking211, Inc',
    model: 'deepseek-flash',
    requests: 7,
    ok: 7,
    errors: 0,
    prompt_tokens: 100n,
    completion_tokens: 50n,
    cache_read_tokens: 10n,
    total_tokens: 150n,
    cost_usd: '0.018000',
    billed_usd: '0.010000',
    byok_requests: 7,
    byok_cost_usd: '0.018000',
  };

  function makeRecon(
    opts: { snapshots?: unknown[]; exchangeRate?: { getCnyPerUsd(): Promise<number> } } = {},
  ) {
    const prisma = {
      $queryRaw: jest.fn().mockResolvedValue([RAW_ROW]),
      dailyFxRate: {
        findMany: jest.fn().mockResolvedValue(opts.snapshots ?? []),
      },
    };
    const svc = new UsageService(
      prisma as unknown as PrismaService,
      {} as unknown as BillingService,
      { get: (_k: string, d?: string) => d } as unknown as ConfigService,
      undefined,
      opts.exchangeRate as any,
    );
    return { svc, prisma };
  }

  it('输出 CSV：表头 + 含逗号的渠道名转义 + BYOK 分列 + 末尾人民币三列', async () => {
    const { svc } = makeRecon({
      snapshots: [{ day: '2026-11-03', cnyPerUsd: '7.100000' }],
    });
    const res = { setHeader: jest.fn(), send: jest.fn() };
    await svc.reconciliationCsv({ id: 'u1', role: Role.ADMIN }, res, {
      from: '2026-11-01',
      to: '2026-11-04',
    });

    const body = res.send.mock.calls[0][0] as string;
    expect(body.startsWith('\uFEFFday,channel,model,requests')).toBe(true);
    expect(body).toContain('"deepseekForWangking211, Inc"');
    expect(body).toContain('0.018000');
    // 人民币三列追加在末尾（避免破坏按列序解析的既有消费方）
    const header = body.slice(1).split('\n')[0];
    expect(header).toBe(
      'day,channel,model,requests,ok,errors,prompt_tokens,completion_tokens,cache_read_tokens,total_tokens,cost_usd,billed_usd,byok_requests,byok_cost_usd,fx_rate,cost_cny,billed_cny',
    );
    const cells = body.slice(1).split('\n')[1].split(',');
    expect(cells.slice(-3)).toEqual(['7.1', '0.1278', '0.071']); // 0.018×7.1 / 0.010×7.1
    expect(res.setHeader).toHaveBeenCalledWith(
      'Content-Disposition',
      expect.stringContaining('reconciliation.csv'),
    );
  });

  it('行人民币列按当日快照折算；快照缺失回退实时汇率', async () => {
    const { svc } = makeRecon({
      snapshots: [], // 无快照 → 回退
      exchangeRate: { getCnyPerUsd: jest.fn().mockResolvedValue(7.2) },
    });

    const rows = await svc.reconciliationRows({ id: 'u1', role: Role.ADMIN });

    expect(rows).toHaveLength(1);
    expect(rows[0].fx_rate).toBe('7.2');
    expect(rows[0].cost_cny).toBe(String(Math.round(0.018 * 7.2 * 1e6) / 1e6));
    expect(rows[0].billed_cny).toBe(String(Math.round(0.01 * 7.2 * 1e6) / 1e6));
  });

  it('快照与实时汇率都不可用 → 人民币列为 null（美元列不受影响）', async () => {
    const { svc } = makeRecon({
      snapshots: [],
      exchangeRate: {
        getCnyPerUsd: jest.fn().mockRejectedValue(new Error('fx down')),
      },
    });

    const rows = await svc.reconciliationRows({ id: 'u1', role: Role.ADMIN });

    expect(rows[0].cost_usd).toBe('0.018000');
    expect(rows[0].fx_rate).toBeNull();
    expect(rows[0].cost_cny).toBeNull();
    expect(rows[0].billed_cny).toBeNull();
  });

  it('未注入汇率服务（@Optional 缺省）→ 人民币列为 null', async () => {
    const { svc } = makeRecon({ snapshots: [] });

    const rows = await svc.reconciliationRows({ id: 'u1', role: Role.ADMIN });

    expect(rows[0].cost_cny).toBeNull();
    expect(rows[0].billed_cny).toBeNull();
  });
});
