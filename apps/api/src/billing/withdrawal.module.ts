import { Module } from '@nestjs/common';
import { WithdrawalService } from './withdrawal.service';
import {
  WithdrawalController,
  AdminWithdrawalController,
} from './withdrawal.controller';

@Module({
  controllers: [WithdrawalController, AdminWithdrawalController],
  providers: [WithdrawalService],
})
export class WithdrawalModule {}
