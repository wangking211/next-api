import { Module } from '@nestjs/common';
import { PaymentService } from './payment.service';
import {
  PaymentController,
  PaymentNotifyController,
} from './payment.controller';

@Module({
  controllers: [PaymentController, PaymentNotifyController],
  providers: [PaymentService],
  exports: [PaymentService],
})
export class PaymentModule {}
