import { Type } from 'class-transformer';
import {
  IsBoolean,
  IsInt,
  IsNumber,
  IsOptional,
  IsString,
  MaxLength,
  Min,
  MinLength,
} from 'class-validator';

/** 渠道 × 模型 的定价项（同一模型可由多个上游提供，价格/折扣各异） */
export class ChannelModelPriceDto {
  @IsString()
  @MinLength(1)
  @MaxLength(128)
  model!: string;

  /** 上游成本 USD/1M tokens */
  @IsOptional()
  @IsNumber({ maxDecimalPlaces: 6 })
  @Min(0)
  costInput?: number;

  @IsOptional()
  @IsNumber({ maxDecimalPlaces: 6 })
  @Min(0)
  costOutput?: number;

  /** 对用户售价 USD/1M tokens（为空则用目录价 × discount） */
  @IsOptional()
  @IsNumber({ maxDecimalPlaces: 6 })
  @Min(0)
  priceInput?: number;

  @IsOptional()
  @IsNumber({ maxDecimalPlaces: 6 })
  @Min(0)
  priceOutput?: number;

  /** 折扣系数 0-1，例如 0.8 表示八折（旧字段，等同 priceDiscount） */
  @IsOptional()
  @IsNumber({ maxDecimalPlaces: 4 })
  @Min(0)
  discount?: number;

  /** 上游成本折扣率（0.3 = 成本为官方价的 30%） */
  @IsOptional()
  @IsNumber({ maxDecimalPlaces: 4 })
  @Min(0)
  costDiscount?: number;

  /** 下游售价折扣率（0.5 = 售价为官方价的 50%） */
  @IsOptional()
  @IsNumber({ maxDecimalPlaces: 4 })
  @Min(0)
  priceDiscount?: number;

  @IsOptional()
  @IsBoolean()
  enabled?: boolean;

  @IsOptional()
  @IsInt()
  @Min(0)
  priority?: number;

  @IsOptional()
  @IsInt()
  @Min(1)
  weight?: number;
}

export class ModelPricesField {
  @IsOptional()
  @Type(() => ChannelModelPriceDto)
  modelPrices?: ChannelModelPriceDto[];
}
