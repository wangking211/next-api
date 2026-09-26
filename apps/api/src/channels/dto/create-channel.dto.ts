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
} from 'class-validator';
import { ChannelOwnerType } from '@prisma/client';

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
}
