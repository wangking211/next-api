import {
  ArrayMaxSize,
  IsArray,
  IsBoolean,
  IsEnum,
  IsInt,
  IsNumber,
  IsOptional,
  IsString,
  Matches,
  MaxLength,
  Min,
  MinLength,
} from 'class-validator';
import { ModelGroupStatus } from '@prisma/client';

/** 分组标识：小写字母/数字/._-，用于对外展示与令牌绑定 */
const NAME_RE = /^[a-zA-Z0-9][a-zA-Z0-9._-]{0,31}$/;

export class CreateGroupDto {
  @IsString()
  @Matches(NAME_RE, { message: 'name 只能包含字母/数字/._-（1-32 位）' })
  name!: string;

  @IsString()
  @MinLength(1)
  @MaxLength(64)
  displayName!: string;

  @IsOptional()
  @IsString()
  @MaxLength(200)
  description?: string;

  /** 分组倍率（作用在渠道用户价之上，不叠乘）；不传/传 null = 不参与，回退用户/代理倍率 */
  @IsOptional()
  @IsNumber({ maxDecimalPlaces: 4 })
  @Min(0)
  ratio?: number | null;

  @IsOptional()
  @IsEnum(ModelGroupStatus)
  status?: ModelGroupStatus;

  @IsOptional()
  @IsInt()
  @Min(0)
  priority?: number;

  /** 默认分组：未指定分组的用户归属（全局仅一个） */
  @IsOptional()
  @IsBoolean()
  isDefault?: boolean;

  /** 可见模型名（空数组 = 不限制，全部模型可见） */
  @IsOptional()
  @IsArray()
  @IsString({ each: true })
  @MaxLength(128, { each: true })
  @ArrayMaxSize(1000)
  models?: string[];
}

export class UpdateGroupDto {
  @IsOptional()
  @IsString()
  @MinLength(1)
  @MaxLength(64)
  displayName?: string;

  @IsOptional()
  @IsString()
  @MaxLength(200)
  description?: string;

  @IsOptional()
  @IsNumber({ maxDecimalPlaces: 4 })
  @Min(0)
  ratio?: number | null;

  @IsOptional()
  @IsEnum(ModelGroupStatus)
  status?: ModelGroupStatus;

  @IsOptional()
  @IsInt()
  @Min(0)
  priority?: number;

  @IsOptional()
  @IsBoolean()
  isDefault?: boolean;

  @IsOptional()
  @IsArray()
  @IsString({ each: true })
  @MaxLength(128, { each: true })
  @ArrayMaxSize(1000)
  models?: string[];
}
