import { Module } from '@nestjs/common';
import { HealthController } from './health.controller';
import { ConfigController } from './config.controller';
import { PaymentModule } from '../billing/payment.module';

@Module({
  imports: [PaymentModule],
  controllers: [HealthController, ConfigController],
})
export class HealthModule {}
