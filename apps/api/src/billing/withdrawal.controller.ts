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
import { Role, WithdrawalStatus } from '@prisma/client';
import { WithdrawalService } from './withdrawal.service';
import { CreateWithdrawalDto } from './dto/create-withdrawal.dto';
import { ReviewWithdrawalDto } from './dto/review-withdrawal.dto';
import { JwtAuthGuard } from '../common/guards/jwt-auth.guard';
import { RolesGuard } from '../common/guards/roles.guard';
import { Roles } from '../common/decorators/roles.decorator';
import { CurrentUser } from '../common/decorators/current-user.decorator';
import { AuthUser } from '../common/interfaces/auth.interface';

@UseGuards(JwtAuthGuard)
@Controller('withdrawals')
export class WithdrawalController {
  constructor(private readonly withdrawals: WithdrawalService) {}

  @Post()
  create(@CurrentUser() user: AuthUser, @Body() dto: CreateWithdrawalDto) {
    return this.withdrawals.create(user.id, dto.amount, dto.note);
  }

  @Get()
  list(@CurrentUser() user: AuthUser) {
    return this.withdrawals.listMine(user.id);
  }
}

@UseGuards(JwtAuthGuard, RolesGuard)
@Roles(Role.ADMIN)
@Controller('admin/withdrawals')
export class AdminWithdrawalController {
  constructor(private readonly withdrawals: WithdrawalService) {}

  @Get()
  list(@Query('status') status?: string) {
    const s = status && status in WithdrawalStatus ? (status as WithdrawalStatus) : undefined;
    return this.withdrawals.listAll(s);
  }

  @Patch(':id')
  review(
    @CurrentUser() user: AuthUser,
    @Param('id') id: string,
    @Body() dto: ReviewWithdrawalDto,
  ) {
    return this.withdrawals.review(user.id, id, dto.action);
  }
}
