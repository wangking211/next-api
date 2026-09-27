import { IsNumber, IsOptional, IsString, MaxLength, Min } from 'class-validator';

export class CreateWithdrawalDto {
  /** 提现金额（USD；前端按积分输入后换算） */
  @IsNumber({ maxDecimalPlaces: 6 })
  @Min(0.000001)
  amount!: number;

  @IsOptional()
  @IsString()
  @MaxLength(200)
  note?: string;
}
