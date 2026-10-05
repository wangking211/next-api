import { Module } from '@nestjs/common';
import { GatewayController } from './gateway.controller';
import { ExecSupportService } from './exec-support.service';
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
  ],
  exports: [ChannelResolverService],
})
export class GatewayModule {}
