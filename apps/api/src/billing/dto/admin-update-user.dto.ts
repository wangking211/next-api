import { IsEnum, IsNumber, IsOptional, IsString, Max, Min } from 'class-validator';
import { Role } from '@prisma/client';

export class AdminUpdateUserDto {
  @IsOptional()
  @IsEnum(Role)
  role?: Role;

  /** 用户价倍率（相对渠道价，≥1 加价，1=与渠道价相同）；传 null 清空（回落代理倍率） */
  @IsOptional()
  @IsNumber({ maxDecimalPlaces: 4 })
  @Min(0)
  @Max(1000)
  priceMultiplier?: number | null;

  /** 归属代理（AGENT 用户的 id）；传 null 解除归属 */
  @IsOptional()
  @IsString()
  agentId?: string | null;
}
