import { Module } from '@nestjs/common';
import { ProviderRegistry } from './provider.registry';
import { UpstreamProbeService } from './upstream-probe.service';

@Module({
  providers: [ProviderRegistry, UpstreamProbeService],
  exports: [ProviderRegistry, UpstreamProbeService],
})
export class ProvidersModule {}
