import {
  ArrayMaxSize,
  IsArray,
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

  /** TPM 上限（每分钟 token 数），不设/0 表示不限制 */
  @IsOptional()
  @IsInt()
  @Min(1)
  tpmLimit?: number;

  /** 模型白名单，空/缺省表示不限制 */
  @IsOptional()
  @IsArray()
  @IsString({ each: true })
  @MaxLength(128, { each: true })
  @ArrayMaxSize(200)
  models?: string[];

  @IsOptional()
  @IsISO8601()
  expiresAt?: string;

  /** 智能路由策略（留空 = 全局默认 ROUTING_STRATEGY） */
  @IsOptional()
  @IsEnum(RoutingStrategy)
  routingStrategy?: RoutingStrategy;

  /** 令牌级分组（仅管理员可设置）；留空 = 用用户所属分组 */
  @IsOptional()
  @IsString()
  @MaxLength(64)
  groupId?: string | null;
}
