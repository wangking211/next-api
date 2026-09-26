import { IsNumber, IsOptional, IsString, MaxLength } from 'class-validator';

export class AdjustDto {
  /** 可正可负，用于人工调整余额 */
  @IsNumber({ maxDecimalPlaces: 6 })
  amount!: number;

  @IsOptional()
  @IsString()
  @MaxLength(200)
  description?: string;
}
