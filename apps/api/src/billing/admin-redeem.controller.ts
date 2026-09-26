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
import { RedeemCodeStatus, Role } from '@prisma/client';
import { BillingService } from './billing.service';
import { GenerateCodesDto } from './dto/generate-codes.dto';
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
@Controller('admin/redeem-codes')
export class AdminRedeemController {
  constructor(private readonly billing: BillingService) {}

  @Post()
  generate(@CurrentUser() operator: AuthUser, @Body() dto: GenerateCodesDto) {
    return this.billing.generateCodes(operator.id, dto);
  }

  @Get()
  list(
    @Query('status') status?: RedeemCodeStatus,
    @Query('batchId') batchId?: string,
    @Query('page') page?: string,
    @Query('pageSize') pageSize?: string,
  ) {
    return this.billing.listCodes(
      toInt(page, 1),
      Math.min(toInt(pageSize, 20), 100),
      status,
      batchId,
    );
  }

  @Patch(':id/disable')
  disable(@Param('id') id: string) {
    return this.billing.disableCode(id);
  }
}
