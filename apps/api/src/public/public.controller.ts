import { Controller, Get, Header } from '@nestjs/common';
import { PublicService } from './public.service';

/**
 * 无需登录的公开端点，供落地页渲染真实模型定价与统计。
 * 短缓存 60s，避免被爬虫/刷新打爆数据库。
 */
@Controller('public')
export class PublicController {
  constructor(private readonly service: PublicService) {}

  @Get('models')
  @Header('Cache-Control', 'public, max-age=60')
  models() {
    return this.service.models();
  }

  @Get('stats')
  @Header('Cache-Control', 'public, max-age=60')
  stats() {
    return this.service.stats();
  }
}
