import {
  ArrayMaxSize,
  IsArray,
  IsBoolean,
  IsEnum,
  IsNumber,
  IsOptional,
  IsString,
  MaxLength,
  Min,
  MinLength,
} from 'class-validator';
import { ModelOrigin } from '@prisma/client';

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

  @IsOptional()
  @IsNumber({ maxDecimalPlaces: 6 })
  @Min(0)
  inputPrice?: number;

  @IsOptional()
  @IsNumber({ maxDecimalPlaces: 6 })
  @Min(0)
  outputPrice?: number;

  @IsOptional()
  @IsNumber({ maxDecimalPlaces: 6 })
  @Min(0)
  cacheReadPrice?: number;

  @IsOptional()
  @IsNumber({ maxDecimalPlaces: 6 })
  @Min(0)
  cacheWritePrice?: number;

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
}
