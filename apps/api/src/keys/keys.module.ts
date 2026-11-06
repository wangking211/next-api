import { Module } from '@nestjs/common';
import { KeysService } from './keys.service';
import { KeysController } from './keys.controller';
import { ProvidersModule } from '../gateway/providers/providers.module';
import { GroupsModule } from '../groups/groups.module';

@Module({
  // ProvidersModule：上游探针（Key 测试连通性复用渠道页同一实现）
  imports: [ProvidersModule, GroupsModule],
  controllers: [KeysController],
  providers: [KeysService],
  exports: [KeysService],
})
export class KeysModule {}
