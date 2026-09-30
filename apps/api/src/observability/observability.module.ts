import { Global, Module } from '@nestjs/common';
import { MetricsController } from './metrics.controller';
import { MetricsService } from './metrics.service';
import { WatchdogService } from './watchdog.service';

/**
 * 观测：Prometheus 指标（/api/metrics）+ 看门狗（依赖健康/证书到期告警）。
 * 全局导出 MetricsService，供 UsageService 等任意模块埋点。
 */
@Global()
@Module({
  controllers: [MetricsController],
  providers: [MetricsService, WatchdogService],
  exports: [MetricsService],
})
export class ObservabilityModule {}
