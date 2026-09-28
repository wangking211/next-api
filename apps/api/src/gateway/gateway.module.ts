import { Module } from '@nestjs/common';
import { GatewayController } from './gateway.controller';
import { ApiKeyGuard } from './guards/api-key.guard';
import { ChannelResolverService } from './channel-resolver.service';
import { ProvidersModule } from './providers/providers.module';
import { RateLimiterService } from './rate-limiter.service';
import { ChannelHealthService } from './channel-health.service';
import { RoutingMetricsService } from './routing-metrics.service';
import { UsageModule } from '../usage/usage.module';
import { BillingModule } from '../billing/billing.module';

@Module({
  imports: [UsageModule, BillingModule, ProvidersModule],
  controllers: [GatewayController],
  providers: [
    ApiKeyGuard,
    ChannelResolverService,
    RateLimiterService,
    ChannelHealthService,
    RoutingMetricsService,
  ],
  exports: [ChannelResolverService],
})
export class GatewayModule {}
