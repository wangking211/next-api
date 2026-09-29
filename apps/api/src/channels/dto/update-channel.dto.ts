import {
  ArrayMinSize,
  IsArray,
  IsEnum,
  IsInt,
  IsOptional,
  IsString,
  IsUrl,
  MaxLength,
  Min,
  MinLength,
  ValidateNested,
} from 'class-validator';
import { Type } from 'class-transformer';
import { ChannelStatus } from '@prisma/client';
import { ChannelModelPriceDto } from './channel-model-price.dto';

export class UpdateChannelDto {
  @IsOptional()
  @IsString()
  @MinLength(1)
  @MaxLength(64)
  name?: string;

  @IsOptional()
  @IsString()
  @MinLength(1)
  @MaxLength(32)
  provider?: string;

  @IsOptional()
  @IsUrl({ require_tld: false })
  @MaxLength(255)
  baseUrl?: string;

  @IsOptional()
  @IsString()
  @MinLength(1)
  @MaxLength(512)
  apiKey?: string;

  @IsOptional()
  @IsArray()
  @ArrayMinSize(1)
  @IsString({ each: true })
  models?: string[];

  @IsOptional()
  @IsInt()
  @Min(1)
  weight?: number;

  @IsOptional()
  @IsInt()
  @Min(0)
  priority?: number;

  /** 每日调用限额（自然日，null = 清除限制） */
  @IsOptional()
  @IsInt()
  @Min(0)
  dailyRequestLimit?: number | null;

  /** 每日 token 限额（prompt+completion，null = 清除限制） */
  @IsOptional()
  @IsInt()
  @Min(0)
  dailyTokenLimit?: number | null;

  @IsOptional()
  @IsEnum(ChannelStatus)
  status?: ChannelStatus;

  @IsOptional()
  @IsArray()
  @ValidateNested({ each: true })
  @Type(() => ChannelModelPriceDto)
  modelPrices?: ChannelModelPriceDto[];

  /** 渠道分组 id 列表（仅管理员可设置）；空数组 = 转为公共渠道 */
  @IsOptional()
  @IsArray()
  @IsString({ each: true })
  @MaxLength(64, { each: true })
  groups?: string[];

  /** 上游计费分组名（仅用于成本核算与展示） */
  @IsOptional()
  @IsString()
  @MaxLength(64)
  upstreamGroup?: string | null;
}
