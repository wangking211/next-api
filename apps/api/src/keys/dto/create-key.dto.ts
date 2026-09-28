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
import { RoutingStrategy } from '@prisma/client';

export class CreateKeyDto {
  @IsString()
  @MinLength(1)
  @MaxLength(64)
  name!: string;

  @IsOptional()
  @IsInt()
  @Min(1)
  quotaLimit?: number;

  @IsOptional()
  @IsNumber({ maxDecimalPlaces: 6 })
  @Min(0)
  costLimit?: number;

  @IsOptional()
  @IsInt()
  @Min(1)
  rpmLimit?: number;

  @IsOptional()
  @IsISO8601()
  expiresAt?: string;

  /** 智能路由策略（留空 = 全局默认 ROUTING_STRATEGY） */
  @IsOptional()
  @IsEnum(RoutingStrategy)
  routingStrategy?: RoutingStrategy;
}
