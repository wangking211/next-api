import { Module } from '@nestjs/common';
import { ChannelsService } from './channels.service';
import { ChannelsController } from './channels.controller';
import { ProvidersModule } from '../gateway/providers/providers.module';
import { GroupsModule } from '../groups/groups.module';
import { GatewayModule } from '../gateway/gateway.module';

@Module({
  // GatewayModule：注入 RoutingMetricsService（渠道 L2 信号：滑窗有效回复率/拒答率）
  imports: [ProvidersModule, GroupsModule, GatewayModule],
  controllers: [ChannelsController],
  providers: [ChannelsService],
  exports: [ChannelsService],
})
export class ChannelsModule {}
