import { IsNumber, Min } from 'class-validator';

export class AgentRechargeDto {
  /** 充值金额（USD；前端按积分输入后换算） */
  @IsNumber({ maxDecimalPlaces: 6 })
  @Min(0.000001)
  amount!: number;
}
