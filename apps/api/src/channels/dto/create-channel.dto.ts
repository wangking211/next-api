import {
  IsArray,
  IsEnum,
  IsInt,
  IsOptional,
  IsString,
  IsUrl,
  MaxLength,
  Min,
  MinLength,
  ArrayMinSize,
  ValidateNested,
} from 'class-validator';
import { Type } from 'class-transformer';
import { ChannelOwnerType } from '@prisma/client';
import { ChannelModelPriceDto } from './channel-model-price.dto';

export class CreateChannelDto {
  @IsString()
  @MinLength(1)
  @MaxLength(64)
  name!: string;

  @IsString()
  @MinLength(1)
  @MaxLength(32)
  provider!: string;

  @IsUrl({ require_tld: false })
  @MaxLength(255)
  baseUrl!: string;

  @IsString()
  @MinLength(1)
  @MaxLength(512)
  apiKey!: string;

  @IsArray()
  @ArrayMinSize(1)
  @IsString({ each: true })
  models!: string[];

  /** 仅管理员可传 PLATFORM */
  @IsOptional()
  @IsEnum(ChannelOwnerType)
  ownerType?: ChannelOwnerType;

  @IsOptional()
  @IsInt()
  @Min(1)
  weight?: number;

  @IsOptional()
  @IsInt()
  @Min(0)
  priority?: number;

  /** 逐模型定价（成本/售价/折扣），同模型可跨渠道各异 */
  @IsOptional()
  @IsArray()
  @ValidateNested({ each: true })
  @Type(() => ChannelModelPriceDto)
  modelPrices?: ChannelModelPriceDto[];
}
