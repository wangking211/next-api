import { Global, Module } from '@nestjs/common';
import { MetricsController } from './metrics.controller';
import { MetricsService } from './metrics.service';
import { WatchdogService } from './watchdog.service';
import { LogRetentionService } from './log-retention.service';

/**
 * 观测：Prometheus 指标（/api/metrics）+ 看门狗（依赖健康/证书到期告警）
 * + 请求日志保留期清理（REQUEST_LOG_RETENTION_DAYS）。
 * 全局导出 MetricsService，供 UsageService 等任意模块埋点。
 */
@Global()
@Module({
  controllers: [MetricsController],
  providers: [MetricsService, WatchdogService, LogRetentionService],
  exports: [MetricsService],
})
export class ObservabilityModule {}
