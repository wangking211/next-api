import { Controller, Get, Post, Body, Query, UseGuards } from '@nestjs/common';
import { BalanceTxType, Role } from '@prisma/client';
import { BillingService } from './billing.service';
import { RedeemDto } from './dto/redeem.dto';
import { JwtAuthGuard } from '../common/guards/jwt-auth.guard';
import { CurrentUser } from '../common/decorators/current-user.decorator';
import { AuthUser } from '../common/interfaces/auth.interface';

function toInt(value: string | undefined, fallback: number): number {
  const n = Number(value);
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : fallback;
}

@UseGuards(JwtAuthGuard)
@Controller('billing')
export class BillingController {
  constructor(private readonly billing: BillingService) {}

  @Get('me')
  me(@CurrentUser() user: AuthUser) {
    return this.billing.getBalance(user.id);
  }

  /**
   * 「我的收益」汇总：账本累计 + 月度趋势 + 各渠道明细（页面 /revenue）。
   * from/to（ISO，RangePicker 本地日界）可选，给定任一即按区间查历史收益。
   */
  @Get('revenue')
  revenue(@CurrentUser() user: AuthUser, @Query('from') from?: string, @Query('to') to?: string) {
    return this.billing.getRevenue(user.id, { from: from || undefined, to: to || undefined });
  }

  @Get('transactions')
  transactions(
    @CurrentUser() user: AuthUser,
    @Query('page') page?: string,
    @Query('pageSize') pageSize?: string,
    @Query('type') type?: BalanceTxType,
    @Query('userId') userId?: string,
  ) {
    const target = userId && user.role === Role.ADMIN ? userId : user.id;
    return this.billing.listTransactions(
      target,
      toInt(page, 1),
      Math.min(toInt(pageSize, 20), 100),
      type,
    );
  }

  @Post('redeem')
  redeem(@CurrentUser() user: AuthUser, @Body() dto: RedeemDto) {
    return this.billing.redeem(user.id, dto.code);
  }
}
