import {
  Body,
  Controller,
  Get,
  Param,
  Patch,
  Post,
  Query,
  Res,
  UseGuards,
} from '@nestjs/common';
import { Response } from 'express';
import { Role, UserStatus } from '@prisma/client';
import { BillingService } from './billing.service';
import { UsersService } from '../users/users.service';
import type { UserListFilters } from '../users/users.service';
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
    @Query('hasKeys') hasKeys?: string,
    @Query('hasChannels') hasChannels?: string,
    @Query('sortBy') sortBy?: string,
    @Query('sortOrder') sortOrder?: string,
  ) {
    return this.users.list(
      this.parseFilters({
        q,
        page,
        pageSize,
        role,
        status,
        groupId,
        agentId,
        balanceMin,
        balanceMax,
        createdFrom,
        createdTo,
        hasKeys,
        hasChannels,
        sortBy,
        sortOrder,
      }),
    );
  }

  /** 按当前筛选导出用户 CSV（上限 1 万行） */
  @Get('export')
  async exportUsers(
    @Res() res: Response,
    @Query('q') q?: string,
    @Query('role') role?: string,
    @Query('status') status?: string,
    @Query('groupId') groupId?: string,
    @Query('agentId') agentId?: string,
    @Query('balanceMin') balanceMin?: string,
    @Query('balanceMax') balanceMax?: string,
    @Query('createdFrom') createdFrom?: string,
    @Query('createdTo') createdTo?: string,
    @Query('hasKeys') hasKeys?: string,
    @Query('hasChannels') hasChannels?: string,
    @Query('sortBy') sortBy?: string,
    @Query('sortOrder') sortOrder?: string,
  ) {
    const { csv } = await this.users.exportCsv(
      this.parseFilters({
        q,
        role,
        status,
        groupId,
        agentId,
        balanceMin,
        balanceMax,
        createdFrom,
        createdTo,
        hasKeys,
        hasChannels,
        sortBy,
        sortOrder,
      }),
    );
    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', 'attachment; filename="users.csv"');
    res.send('\uFEFF' + csv);
  }

  /** 列表与导出共用的查询参数解析 */
  private parseFilters(src: {
    q?: string;
    page?: string;
    pageSize?: string;
    role?: string;
    status?: string;
    groupId?: string;
    agentId?: string;
    balanceMin?: string;
    balanceMax?: string;
    createdFrom?: string;
    createdTo?: string;
    hasKeys?: string;
    hasChannels?: string;
    sortBy?: string;
    sortOrder?: string;
  }): UserListFilters {
    const bool = (v?: string): boolean | undefined =>
      v === 'true' ? true : v === 'false' ? false : undefined;
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
    return {
      q: src.q?.trim() || undefined,
      page: src.page ? toInt(src.page, 1) : undefined,
      pageSize: src.pageSize ? Math.min(toInt(src.pageSize, 20), 100) : undefined,
      role: src.role && src.role in Role ? (src.role as Role) : undefined,
      status:
        src.status && src.status in UserStatus ? (src.status as UserStatus) : undefined,
      groupId: src.groupId?.trim() || undefined,
      agentId: src.agentId?.trim() || undefined,
      balanceMin: num(src.balanceMin),
      balanceMax: num(src.balanceMax),
      createdFrom: date(src.createdFrom),
      createdTo: date(src.createdTo),
      hasKeys: bool(src.hasKeys),
      hasChannels: bool(src.hasChannels),
      sortBy: sortFields.includes(src.sortBy as (typeof sortFields)[number])
        ? (src.sortBy as (typeof sortFields)[number])
        : undefined,
      sortOrder:
        src.sortOrder === 'asc' ? 'asc' : src.sortOrder === 'desc' ? 'desc' : undefined,
    };
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
