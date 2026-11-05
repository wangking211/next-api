import {
  ArrayMaxSize,
  IsArray,
  IsBoolean,
  IsEnum,
  IsNumber,
  IsOptional,
  IsString,
  Max,
  MaxLength,
  Min,
  MinLength,
} from 'class-validator';
import { ModelOrigin, PriceCurrency } from '@prisma/client';

export class CreateModelDto {
  @IsString()
  @MinLength(1)
  @MaxLength(128)
  name!: string;

  @IsString()
  @MinLength(1)
  @MaxLength(128)
  displayName!: string;

  @IsString()
  @MinLength(1)
  @MaxLength(32)
  provider!: string;

  /** 官方标价（按 priceCurrency 计价，如 CNY 时为 ¥/1M tokens）；保存时按 fxRate 折算 USD 记账 */
  @IsOptional()
  @IsNumber({ maxDecimalPlaces: 6 })
  @Min(0)
  inputPrice?: number;

  /** 官方标价（按 priceCurrency） */
  @IsOptional()
  @IsNumber({ maxDecimalPlaces: 6 })
  @Min(0)
  outputPrice?: number;

  /** 官方标价（按 priceCurrency） */
  @IsOptional()
  @IsNumber({ maxDecimalPlaces: 6 })
  @Min(0)
  cacheReadPrice?: number;

  /** 官方标价（按 priceCurrency） */
  @IsOptional()
  @IsNumber({ maxDecimalPlaces: 6 })
  @Min(0)
  cacheWritePrice?: number;

  /** 官方标价币种：CNY=人民币官方价（国产模型）/ USD=美元；默认 USD（存量行均为 USD 口径） */
  @IsOptional()
  @IsEnum(PriceCurrency)
  priceCurrency?: PriceCurrency;

  /** 录入时汇率快照（1 USD = N CNY）：priceCurrency=CNY 时必填，USD 记账价 = 官方价 ÷ 该汇率 */
  @IsOptional()
  @IsNumber()
  @Min(2)
  @Max(20)
  fxRate?: number;

  @IsOptional()
  @IsBoolean()
  enabled?: boolean;

  /** 能力标签：vision / tools / reasoning / json_mode 等；空 = 未标注（能力检查放行） */
  @IsOptional()
  @IsArray()
  @IsString({ each: true })
  @MaxLength(32, { each: true })
  @ArrayMaxSize(32)
  capabilities?: string[];

  /** 模型产地：DOMESTIC=国产 / OVERSEAS=海外；留空按模型名自动推断 */
  @IsOptional()
  @IsEnum(ModelOrigin)
  origin?: ModelOrigin;

  /** 按次官方价（按 priceCurrency，如 ¥/次）：图片等非 token 计费模型；留空 = 走 token 计价 */
  @IsOptional()
  @IsNumber({ maxDecimalPlaces: 6 })
  @Min(0)
  perCallPrice?: number | null;

  /** 厂商规范名（留空按模型名自动推断） */
  @IsOptional()
  @IsString()
  @MaxLength(32)
  vendor?: string | null;

  /** 别名（如 gpt-5:latest）：请求命中时解析到本模型的规范名 */
  @IsOptional()
  @IsArray()
  @IsString({ each: true })
  @MaxLength(128, { each: true })
  @ArrayMaxSize(32)
  aliases?: string[];

  /** 低谷价倍率（0~1，如 0.5）；留空/1 = 无峰谷差异 */
  @IsOptional()
  @IsNumber({ maxDecimalPlaces: 4 })
  @Min(0)
  @Max(1)
  offPeakMultiplier?: number | null;
}
