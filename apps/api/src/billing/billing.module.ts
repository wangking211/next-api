import { Module } from '@nestjs/common';
import { BillingService } from './billing.service';
import { BillingController } from './billing.controller';
import { AdminUsersController } from './admin-users.controller';
import { AdminRedeemController } from './admin-redeem.controller';
import { UsersModule } from '../users/users.module';

@Module({
  imports: [UsersModule],
  controllers: [BillingController, AdminUsersController, AdminRedeemController],
  providers: [BillingService],
  exports: [BillingService],
})
export class BillingModule {}
