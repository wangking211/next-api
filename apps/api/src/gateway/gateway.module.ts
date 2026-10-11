import { Module } from '@nestjs/common';
import { GatewayController } from './gateway.controller';
import { ExecSupportService } from './exec-support.service';
import { VideoExecutorService } from './video-executor.service';
import { EmbeddingsExecutorService } from './embeddings-executor.service';
import { ImagesExecutorService } from './images-executor.service';
import { ChatExecutorService } from './chat-executor.service';
import { ApiKeyGuard } from './guards/api-key.guard';
import { ChannelResolverService } from './channel-resolver.service';
import { ProvidersModule } from './providers/providers.module';
import { RateLimiterService } from './rate-limiter.service';
import { ChannelHealthService } from './channel-health.service';
import { RoutingMetricsService } from './routing-metrics.service';
import { VideoTaskService } from './video-task.service';
import { UsageModule } from '../usage/usage.module';
import { BillingModule } from '../billing/billing.module';
import { GroupsModule } from '../groups/groups.module';

@Module({
  imports: [UsageModule, BillingModule, ProvidersModule, GroupsModule],
  controllers: [GatewayController],
  providers: [
    ApiKeyGuard,
    ChannelResolverService,
    RateLimiterService,
    ChannelHealthService,
    RoutingMetricsService,
    VideoTaskService,
    ExecSupportService,
    VideoExecutorService,
    EmbeddingsExecutorService,
    ImagesExecutorService,
    ChatExecutorService,
  ],
  // RoutingMetricsService 导出给控制台渠道模块（L2 信号展示，供人工校准 qualityScore）
  exports: [ChannelResolverService, RoutingMetricsService],
})
export class GatewayModule {}
