import { IsInt, IsOptional, IsString, Max, MaxLength, Min } from 'class-validator';

/** 创建在线充值订单（微信/支付宝） */
export class CreatePaymentOrderDto {
  /** 充值金额，单位：分（人民币），1 元 = 100 分；最小 1 元、最大 5000 元 */
  @IsInt()
  @Min(100)
  @Max(500000)
  amountCents!: number;

  /** 支付方式：QR_CASHIER（通用收银台，默认）/ WX_NATIVE / ALI_QR 等 */
  @IsOptional()
  @IsString()
  @MaxLength(32)
  wayCode?: string;
}
