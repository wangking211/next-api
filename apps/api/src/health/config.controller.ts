import { Controller, Get } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';

@Controller('config')
export class ConfigController {
  constructor(private readonly config: ConfigService) {}

  /** 公共配置（无需登录） */
  @Get()
  get() {
    const creditsPerUsd =
      Number(this.config.get<string>('CREDITS_PER_USD', '100')) || 100;
    const cnyPerUsd =
      Number(this.config.get<string>('PAY_CNY_PER_USD', '7.1')) || 7.1;
    return {
      creditsPerUsd,
      /** 每 1 元人民币可充入的积分 */
      creditsPerCny: Math.round((creditsPerUsd / cnyPerUsd) * 100) / 100,
      /** 在线支付是否已开通（JAIPay 三项密钥齐全） */
      payEnabled: Boolean(
        this.config.get<string>('JAIPAY_MCH_NO') &&
          this.config.get<string>('JAIPAY_APP_ID') &&
          this.config.get<string>('JAIPAY_APP_SECRET'),
      ),
      rebateMode: (this.config.get<string>('REBATE_MODE', 'stacked') || 'stacked'),
      testMaxModels: Number(this.config.get<string>('TEST_MAX_MODELS', '100')) || 100,
    };
  }
}
