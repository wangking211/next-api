import { ConfigService } from '@nestjs/config';
import { ConfigController } from './config.controller';
import { PaymentService } from '../billing/payment.service';

function makeController(opts: { payEnabled?: boolean; quote?: jest.Mock } = {}) {
  const config = {
    get: (k: string, d?: string) => (k === 'CREDITS_PER_USD' ? '100' : d),
  } as unknown as ConfigService;
  const payment = {
    isConfigured: jest.fn(() => opts.payEnabled ?? false),
    quote: opts.quote ?? jest.fn(async () => ({ cnyPerUsd: 6.9, creditsPerCny: 14.49 })),
  } as unknown as PaymentService;
  return new ConfigController(config, payment);
}

describe('ConfigController 公共配置', () => {
  it('在线支付未开通也暴露汇率：控制台展示币种/¥ 换算依赖它', async () => {
    const c = makeController({ payEnabled: false });

    const res = await c.get();

    expect(res.payEnabled).toBe(false);
    expect(res.payRate).toBe(6.9);
    expect(res.creditsPerCny).toBe(14.49);
    expect(res.creditsPerUsd).toBe(100);
    expect(res.testMaxModels).toBe(100);
  });

  it('汇率获取失败回退 null，不影响其它公共配置', async () => {
    const c = makeController({
      quote: jest.fn(async () => {
        throw new Error('fx down');
      }),
    });

    const res = await c.get();

    expect(res.payRate).toBeNull();
    expect(res.creditsPerCny).toBeNull();
    expect(res.creditsPerUsd).toBe(100);
    expect(res.testMaxModels).toBe(100);
  });
});
