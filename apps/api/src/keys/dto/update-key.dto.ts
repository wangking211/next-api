import {
  IsEnum,
  IsInt,
  IsISO8601,
  IsNumber,
  IsOptional,
  IsString,
  MaxLength,
  Min,
  MinLength,
} from 'class-validator';
import { ApiKeyStatus, RoutingStrategy } from '@prisma/client';

export class UpdateKeyDto {
  @IsOptional()
  @IsString()
  @MinLength(1)
  @MaxLength(64)
  name?: string;

  @IsOptional()
  @IsEnum(ApiKeyStatus)
  status?: ApiKeyStatus;

  @IsOptional()
  @IsInt()
  @Min(1)
  quotaLimit?: number | null;

  @IsOptional()
  @IsNumber({ maxDecimalPlaces: 6 })
  @Min(0)
  costLimit?: number | null;

  @IsOptional()
  @IsInt()
  @Min(1)
  rpmLimit?: number | null;

  @IsOptional()
  @IsISO8601()
  expiresAt?: string | null;

  /** 智能路由策略（null = 清除，回退全局默认） */
  @IsOptional()
  @IsEnum(RoutingStrategy)
  routingStrategy?: RoutingStrategy | null;
}
