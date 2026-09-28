import { ConfigService } from '@nestjs/config';
import { PrismaService } from '../prisma/prisma.service';
import { PaymentService } from './payment.service';
import { jaiPaySign } from './jai-pay.sign';

const SECRET = 'test-secret';
const user = { id: 'u1', username: 'u', role: 'USER' } as any;

function makeService(
  opts: {
    env?: Record<string, string>;
    order?: any;
    claimCount?: number;
    rate?: number;
  } = {},
) {
  const env: Record<string, string> = {
    JAIPAY_MCH_NO: 'M1',
    JAIPAY_APP_ID: 'APP1',
    JAIPAY_APP_SECRET: SECRET,
    CREDITS_PER_USD: '100',
    ...(opts.env ?? {}),
  };
  const config = {
    get: (k: string, d?: string) => env[k] ?? d,
  } as unknown as ConfigService;

  const exchangeRate = {
    getCnyPerUsd: jest.fn().mockResolvedValue(opts.rate ?? 7.1),
  };

  const order: any = {
    id: 'o1',
    userId: 'u1',
    mchOrderNo: 'PAY1',
    payOrderId: null,
    wayCode: 'QR_CASHIER',
    channel: null,
    channelOrderNo: null,
    amountCents: 100,
    creditUsd: 0.140845,
    credits: 14.08,
    status: 'PENDING',
    paidAt: null,
    createdAt: new Date('2026-09-28T00:00:00Z'),
    ...(opts.order ?? {}),
  };

  const tx = {
    paymentOrder: {
      updateMany: jest.fn().mockResolvedValue({ count: opts.claimCount ?? 1 }),
    },
    user: { update: jest.fn().mockResolvedValue({ balance: 100.140845 }) },
    balanceTransaction: { create: jest.fn().mockResolvedValue({}) },
  };
  const prisma = {
    paymentOrder: {
      create: jest.fn().mockResolvedValue(order),
      update: jest.fn().mockResolvedValue(order),
      findUnique: jest.fn().mockResolvedValue(
        opts.order === null ? null : order,
      ),
      findMany: jest.fn().mockResolvedValue([order]),
    },
    $transaction: (cb: any) => cb(tx),
  };

  const service = new PaymentService(
    prisma as unknown as PrismaService,
    config,
    exchangeRate as any,
  );
  return { service, prisma, tx, order, exchangeRate };
}

function mockFetch(json: any, ok = true, status = 200) {
  return jest
    .spyOn(global, 'fetch')
    .mockResolvedValue({ ok, status, statusText: 'OK', json: async () => json } as any);
}

describe('PaymentService.createOrder', () => {
  afterEach(() => jest.restoreAllMocks());

  it('creates an order, calls JAIPay and returns pay data', async () => {
    const { service, prisma } = makeService();
    const spy = mockFetch({
      code: 0,
      msg: 'SUCCESS',
      data: {
        payOrderId: 'P1',
        payDataType: 'codeUrl',
        payData: 'weixin://wxpay/bizpayurl?pr=x',
      },
    });

    const res = await service.createOrder(user, 100); // 1 元

    expect(prisma.paymentOrder.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        userId: 'u1',
        wayCode: 'QR_CASHIER',
        amountCents: 100,
        creditUsd: 0.140845, // 1 元 / 7.1
        credits: 14.08, // × 100 积分/USD
      }),
    });

    const [url, init] = spy.mock.calls[0];
    expect(url).toBe('https://pay.zxixing.com/api/pay/unifiedOrder');
    const body = JSON.parse((init as RequestInit).body as string);
    expect(body).toMatchObject({
      mchNo: 'M1',
      appId: 'APP1',
      wayCode: 'QR_CASHIER',
      amount: 100,
      currency: 'cny',
      signType: 'MD5',
      version: '1.0',
    });
    expect(body.notifyUrl).toBe('https://xiaopuyun.com/api/pay/jai/notify');
    expect(typeof body.sign).toBe('string');
    expect(body.sign.length).toBe(32);

    expect(prisma.paymentOrder.update).toHaveBeenCalledWith({
      where: { id: 'o1' },
      data: { payOrderId: 'P1' },
    });
    expect(res).toMatchObject({
      mchOrderNo: expect.stringMatching(/^PAY/),
      credits: 14.08,
      payDataType: 'codeUrl',
      payData: 'weixin://wxpay/bizpayurl?pr=x',
      status: 'PENDING',
    });
  });

  it('uses the live exchange rate to convert RMB into credits', async () => {
    const { service, prisma } = makeService({ rate: 7.25 });
    mockFetch({ code: 0, data: { payData: 'x' } });
    const res = await service.createOrder(user, 100); // 1 元
    expect(prisma.paymentOrder.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        creditUsd: 0.137931, // 1 / 7.25
        credits: 13.79, // × 100 积分/USD
      }),
    });
    expect(res.credits).toBe(13.79);
  });

  it('honours the credits-per-USD config when converting', async () => {
    const { service, prisma } = makeService({ env: { CREDITS_PER_USD: '50' } });
    mockFetch({ code: 0, data: { payData: 'x' } });
    const res = await service.createOrder(user, 100);
    expect(prisma.paymentOrder.create).toHaveBeenCalledWith({
      data: expect.objectContaining({ credits: 7.04 }), // 1/7.1 × 50
    });
    expect(res.credits).toBe(7.04);
  });

  it('quotes the rate and credits per RMB', async () => {
    const { service } = makeService({ rate: 7.25 });
    await expect(service.quote()).resolves.toEqual({
      cnyPerUsd: 7.25,
      creditsPerCny: 13.79,
    });
  });

  it('rejects when JAIPay is not configured', async () => {
    const { service } = makeService({ env: { JAIPAY_APP_SECRET: '' } });
    await expect(service.createOrder(user, 100)).rejects.toThrow(/未开通/);
  });

  it('rejects unsupported way codes', async () => {
    const { service } = makeService();
    await expect(service.createOrder(user, 100, 'HACK')).rejects.toThrow(/不支持/);
  });

  it('marks the order failed when the gateway rejects', async () => {
    const { service, prisma } = makeService();
    mockFetch({ code: 4, msg: 'AMOUNT_ERROR' });
    await expect(service.createOrder(user, 100)).rejects.toThrow(/下单失败（4）/);
    expect(prisma.paymentOrder.update).toHaveBeenCalledWith({
      where: { id: 'o1' },
      data: { status: 'FAILED' },
    });
  });
});

describe('PaymentService.handleNotify', () => {
  afterEach(() => jest.restoreAllMocks());

  function signedQuery(over: Record<string, string> = {}) {
    const params: Record<string, string> = {
      mchOrderNo: 'PAY1',
      payOrderId: 'P1',
      ifCode: 'wxpay',
      amount: '100',
      state: '2',
      channelOrderNo: 'C1',
      successTime: '1715843200000',
      ...over,
    };
    return { ...params, sign: jaiPaySign(params, SECRET) };
  }

  it('rejects tampered notifications', async () => {
    const { service, tx } = makeService();
    await expect(
      service.handleNotify({ ...signedQuery(), amount: '99999' }),
    ).rejects.toThrow(/签名校验失败/);
    expect(tx.user.update).not.toHaveBeenCalled();
  });

  it('ignores non-success states', async () => {
    const { service, tx } = makeService();
    const res = await service.handleNotify(signedQuery({ state: '1' }));
    expect(res).toMatchObject({ skipped: 'state' });
    expect(tx.user.update).not.toHaveBeenCalled();
  });

  it('ignores unknown orders', async () => {
    const { service, tx } = makeService({ order: null });
    const res = await service.handleNotify(signedQuery());
    expect(res).toMatchObject({ skipped: 'unknown-order' });
    expect(tx.user.update).not.toHaveBeenCalled();
  });

  it('ignores amount mismatch', async () => {
    const { service, tx } = makeService();
    const res = await service.handleNotify(signedQuery({ amount: '200' }));
    expect(res).toMatchObject({ skipped: 'amount-mismatch' });
    expect(tx.user.update).not.toHaveBeenCalled();
  });

  it('credits the balance exactly once on success', async () => {
    const { service, tx } = makeService();
    const res = await service.handleNotify(signedQuery());

    expect(res).toEqual({ ok: true });
    expect(tx.paymentOrder.updateMany).toHaveBeenCalledWith({
      where: { id: 'o1', status: 'PENDING' },
      data: expect.objectContaining({
        status: 'PAID',
        channel: 'wxpay',
        channelOrderNo: 'C1',
        paidAt: new Date(1715843200000),
      }),
    });
    expect(tx.user.update).toHaveBeenCalledWith({
      where: { id: 'u1' },
      data: { balance: { increment: 0.140845 } },
      select: { balance: true },
    });
    expect(tx.balanceTransaction.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        userId: 'u1',
        type: 'RECHARGE',
        amount: 0.140845,
        balanceAfter: 100.140845,
        description: expect.stringContaining('在线充值 ¥1.00'),
      }),
    });
  });

  it('does not credit twice for a paid order', async () => {
    const { service, tx } = makeService({ order: { status: 'PAID' } });
    const res = await service.handleNotify(signedQuery());
    expect(res).toMatchObject({ skipped: 'duplicate' });
    expect(tx.user.update).not.toHaveBeenCalled();
  });

  it('does not credit when another callback already claimed it', async () => {
    const { service, tx } = makeService({ claimCount: 0 });
    await service.handleNotify(signedQuery());
    expect(tx.user.update).not.toHaveBeenCalled();
    expect(tx.balanceTransaction.create).not.toHaveBeenCalled();
  });
});

describe('PaymentService.getOrder', () => {
  it('hides other users orders from non-admins', async () => {
    const { service } = makeService({ order: { userId: 'someone-else' } });
    await expect(service.getOrder(user, 'o1')).rejects.toThrow(/订单不存在/);
  });

  it('lets admins read any order', async () => {
    const { service } = makeService({ order: { userId: 'someone-else' } });
    const res = await service.getOrder({ ...user, role: 'ADMIN' } as any, 'o1');
    expect(res).toMatchObject({ id: 'o1', credits: 14.08 });
  });
});
