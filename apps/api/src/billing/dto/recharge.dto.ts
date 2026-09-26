import { IsNumber, IsOptional, IsString, MaxLength, Min } from 'class-validator';

export class RechargeDto {
  @IsNumber({ maxDecimalPlaces: 6 })
  @Min(0.000001)
  amount!: number;

  @IsOptional()
  @IsString()
  @MaxLength(200)
  description?: string;
}
