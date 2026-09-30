import { Module } from '@nestjs/common';
import { BillingService } from './billing.service';
import { BillingController } from './billing.controller';
import { AdminUsersController } from './admin-users.controller';
import { AdminRedeemController } from './admin-redeem.controller';
import { UsersModule } from '../users/users.module';
import { KeysModule } from '../keys/keys.module';

@Module({
  imports: [UsersModule, KeysModule],
  controllers: [BillingController, AdminUsersController, AdminRedeemController],
  providers: [BillingService],
  exports: [BillingService],
})
export class BillingModule {}
