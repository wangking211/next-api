import { Controller, Get } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';

@Controller('config')
export class ConfigController {
  constructor(private readonly config: ConfigService) {}

  /** 公共配置（无需登录） */
  @Get()
  get() {
    return {
      creditsPerUsd: Number(this.config.get<string>('CREDITS_PER_USD', '100')) || 100,
    };
  }
}
