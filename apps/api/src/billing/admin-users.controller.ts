import {
  Body,
  Controller,
  Get,
  Param,
  Post,
  Query,
  UseGuards,
} from '@nestjs/common';
import { Role } from '@prisma/client';
import { BillingService } from './billing.service';
import { UsersService } from '../users/users.service';
import { RechargeDto } from './dto/recharge.dto';
import { AdjustDto } from './dto/adjust.dto';
import { JwtAuthGuard } from '../common/guards/jwt-auth.guard';
import { RolesGuard } from '../common/guards/roles.guard';
import { Roles } from '../common/decorators/roles.decorator';
import { CurrentUser } from '../common/decorators/current-user.decorator';
import { AuthUser } from '../common/interfaces/auth.interface';

function toInt(value: string | undefined, fallback: number): number {
  const n = Number(value);
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : fallback;
}

@UseGuards(JwtAuthGuard, RolesGuard)
@Roles(Role.ADMIN)
@Controller('admin/users')
export class AdminUsersController {
  constructor(
    private readonly users: UsersService,
    private readonly billing: BillingService,
  ) {}

  @Get()
  list(
    @Query('q') q?: string,
    @Query('page') page?: string,
    @Query('pageSize') pageSize?: string,
  ) {
    return this.users.list(q, toInt(page, 1), Math.min(toInt(pageSize, 20), 100));
  }

  @Get(':id/balance')
  balance(@Param('id') id: string) {
    return this.billing.getBalance(id);
  }

  @Get(':id/transactions')
  transactions(
    @Param('id') id: string,
    @Query('page') page?: string,
    @Query('pageSize') pageSize?: string,
  ) {
    return this.billing.listTransactions(id, toInt(page, 1), Math.min(toInt(pageSize, 20), 100));
  }

  @Post(':id/recharge')
  recharge(
    @CurrentUser() operator: AuthUser,
    @Param('id') id: string,
    @Body() dto: RechargeDto,
  ) {
    return this.billing.recharge(operator.id, id, dto.amount, dto.description);
  }

  @Post(':id/adjust')
  adjust(
    @CurrentUser() operator: AuthUser,
    @Param('id') id: string,
    @Body() dto: AdjustDto,
  ) {
    return this.billing.adjust(operator.id, id, dto.amount, dto.description);
  }
}
