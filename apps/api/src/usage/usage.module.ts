import { Module } from '@nestjs/common';
import { UsageController } from './usage.controller';
import { UsageService } from './usage.service';
import { BillingModule } from '../billing/billing.module';
import { PaymentModule } from '../billing/payment.module';

@Module({
  imports: [BillingModule, PaymentModule],
  controllers: [UsageController],
  providers: [UsageService],
  exports: [UsageService],
})
export class UsageModule {}
