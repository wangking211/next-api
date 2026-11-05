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

export class UpdateModelDto {
  @IsOptional()
  @IsString()
  @MinLength(1)
  @MaxLength(128)
  displayName?: string;

  @IsOptional()
  @IsString()
  @MinLength(1)
  @MaxLength(32)
  provider?: string;

  /** 官方标价（按 priceCurrency 计价）；保存时按 fxRate 折算 USD 记账 */
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

  /** 官方标价币种：变更时必须携带全套官方价（避免原币价跨币种错读） */
  @IsOptional()
  @IsEnum(PriceCurrency)
  priceCurrency?: PriceCurrency;

  /** 录入时汇率快照（1 USD = N CNY）：变更时必须携带全套官方价重算 USD 记账价 */
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

  /** 模型产地：DOMESTIC=国产 / OVERSEAS=海外 */
  @IsOptional()
  @IsEnum(ModelOrigin)
  origin?: ModelOrigin;

  /** 按次官方价（按 priceCurrency）：图片等非 token 计费模型；null 清除 */
  @IsOptional()
  @IsNumber({ maxDecimalPlaces: 6 })
  @Min(0)
  perCallPrice?: number | null;

  /** 厂商规范名 */
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

  /** 低谷价倍率（0~1，如 0.5）；null/1 = 清除（无峰谷差异） */
  @IsOptional()
  @IsNumber({ maxDecimalPlaces: 4 })
  @Min(0)
  @Max(1)
  offPeakMultiplier?: number | null;
}
