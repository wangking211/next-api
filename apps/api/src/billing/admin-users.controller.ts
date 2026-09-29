import {
  Body,
  Controller,
  Get,
  Param,
  Patch,
  Post,
  Query,
  UseGuards,
} from '@nestjs/common';
import { Role, UserStatus } from '@prisma/client';
import { BillingService } from './billing.service';
import { UsersService } from '../users/users.service';
import { RechargeDto } from './dto/recharge.dto';
import { AdjustDto } from './dto/adjust.dto';
import { AdminUpdateUserDto } from './dto/admin-update-user.dto';
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
    @Query('role') role?: string,
    @Query('status') status?: string,
    @Query('groupId') groupId?: string,
    @Query('agentId') agentId?: string,
    @Query('balanceMin') balanceMin?: string,
    @Query('balanceMax') balanceMax?: string,
    @Query('createdFrom') createdFrom?: string,
    @Query('createdTo') createdTo?: string,
    @Query('sortBy') sortBy?: string,
    @Query('sortOrder') sortOrder?: string,
  ) {
    const roleFilter = role && role in Role ? (role as Role) : undefined;
    const statusFilter =
      status && status in UserStatus ? (status as UserStatus) : undefined;
    const num = (v?: string): number | undefined => {
      if (v == null || v.trim() === '') return undefined;
      const n = Number(v);
      return Number.isFinite(n) ? n : undefined;
    };
    const date = (v?: string): Date | undefined => {
      if (!v) return undefined;
      const d = new Date(v);
      return Number.isNaN(d.getTime()) ? undefined : d;
    };
    const sortFields = ['createdAt', 'balance', 'username'] as const;
    return this.users.list({
      q,
      page: toInt(page, 1),
      pageSize: Math.min(toInt(pageSize, 20), 100),
      role: roleFilter,
      status: statusFilter,
      groupId: groupId?.trim() || undefined,
      agentId: agentId?.trim() || undefined,
      balanceMin: num(balanceMin),
      balanceMax: num(balanceMax),
      createdFrom: date(createdFrom),
      createdTo: date(createdTo),
      sortBy: sortFields.includes(sortBy as (typeof sortFields)[number])
        ? (sortBy as (typeof sortFields)[number])
        : undefined,
      sortOrder: sortOrder === 'asc' ? 'asc' : sortOrder === 'desc' ? 'desc' : undefined,
    });
  }

  @Patch(':id')
  update(@Param('id') id: string, @Body() dto: AdminUpdateUserDto) {
    return this.users.updateUser(id, dto);
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
