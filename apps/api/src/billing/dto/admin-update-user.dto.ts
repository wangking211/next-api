import { IsEnum, IsNumber, IsOptional, IsString, Max, Min } from 'class-validator';
import { Role } from '@prisma/client';

export class AdminUpdateUserDto {
  @IsOptional()
  @IsEnum(Role)
  role?: Role;

  /** 额外售价折扣率（0-1）；传 null 清空（回落到代理折扣） */
  @IsOptional()
  @IsNumber({ maxDecimalPlaces: 4 })
  @Min(0)
  @Max(1)
  discount?: number | null;

  /** 归属代理（AGENT 用户的 id）；传 null 解除归属 */
  @IsOptional()
  @IsString()
  agentId?: string | null;
}
