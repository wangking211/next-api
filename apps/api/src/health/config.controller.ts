import { Controller, Get } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { PaymentService } from '../billing/payment.service';

@Controller('config')
export class ConfigController {
  constructor(
    private readonly config: ConfigService,
    private readonly payment: PaymentService,
  ) {}

  /** 公共配置（无需登录） */
  @Get()
  async get() {
    const creditsPerUsd =
      Number(this.config.get<string>('CREDITS_PER_USD', '100')) || 100;
    const payEnabled = this.payment.isConfigured();

    let payRate: number | null = null;
    let creditsPerCny: number | null = null;
    if (payEnabled) {
      try {
        const quote = await this.payment.quote();
        payRate = quote.cnyPerUsd;
        creditsPerCny = quote.creditsPerCny;
      } catch {
        /* 实时汇率暂不可用：前端提示稍后重试，不影响其它公共配置 */
      }
    }

    return {
      creditsPerUsd,
      /** 1 美元 = ? 元人民币（实时汇率或固定值；在线支付未开通/汇率不可用时为 null） */
      payRate,
      /** 每 1 元人民币可充入的积分 */
      creditsPerCny,
      /** 在线支付是否已开通（JAIPay 三项密钥齐全） */
      payEnabled,
      rebateMode: (this.config.get<string>('REBATE_MODE', 'stacked') || 'stacked'),
      testMaxModels: Number(this.config.get<string>('TEST_MAX_MODELS', '100')) || 100,
    };
  }
}
