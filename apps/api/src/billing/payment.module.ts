import { Module } from '@nestjs/common';
import { PaymentService } from './payment.service';
import { ExchangeRateService } from './exchange-rate.service';
import {
  PaymentController,
  PaymentNotifyController,
} from './payment.controller';

@Module({
  controllers: [PaymentController, PaymentNotifyController],
  providers: [PaymentService, ExchangeRateService],
  exports: [PaymentService, ExchangeRateService],
})
export class PaymentModule {}
