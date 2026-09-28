import {
  Body,
  Controller,
  Get,
  Logger,
  Param,
  Post,
  Query,
  UseGuards,
} from '@nestjs/common';
import { JwtAuthGuard } from '../common/guards/jwt-auth.guard';
import { CurrentUser } from '../common/decorators/current-user.decorator';
import { AuthUser } from '../common/interfaces/auth.interface';
import { CreatePaymentOrderDto } from './dto/create-payment-order.dto';
import { PaymentService } from './payment.service';

/** 用户侧：在线充值（微信/支付宝） */
@UseGuards(JwtAuthGuard)
@Controller('billing/pay')
export class PaymentController {
  constructor(private readonly payment: PaymentService) {}

  @Post('orders')
  create(@CurrentUser() user: AuthUser, @Body() dto: CreatePaymentOrderDto) {
    return this.payment.createOrder(user, dto.amountCents, dto.wayCode);
  }

  @Get('orders')
  list(@CurrentUser() user: AuthUser, @Query('limit') limit?: string) {
    return this.payment.listOrders(user, Number(limit) || 10);
  }

  @Get('orders/:id')
  get(@CurrentUser() user: AuthUser, @Param('id') id: string) {
    return this.payment.getOrder(user, id);
  }
}

/**
 * JAIPay 异步通知（公开路由，无需鉴权）。
 * JAIPay 以 HTTP GET + Query String 回调，处理成功必须返回 200；异常返回非 200 会触发重试。
 */
@Controller('pay/jai')
export class PaymentNotifyController {
  private readonly logger = new Logger(PaymentNotifyController.name);

  constructor(private readonly payment: PaymentService) {}

  @Get('notify')
  async notify(@Query() query: Record<string, string>): Promise<string> {
    await this.payment.handleNotify(query);
    return 'SUCCESS';
  }
}
