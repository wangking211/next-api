import {
  IsArray,
  IsEnum,
  IsInt,
  IsISO8601,
  IsNumber,
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
import { ChannelOwnerType, ChannelShareMode, ChannelShareUrgency } from '@prisma/client';
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

  /** 每日调用限额（自然日，0/留空 = 不限）；超限后智能路由排除该渠道 */
  @IsOptional()
  @IsInt()
  @Min(0)
  dailyRequestLimit?: number | null;

  /** 每日 token 限额（prompt+completion，0/留空 = 不限） */
  @IsOptional()
  @IsInt()
  @Min(0)
  dailyTokenLimit?: number | null;

  /** 逐模型定价（成本/售价/折扣），同模型可跨渠道各异 */
  @IsOptional()
  @IsArray()
  @ValidateNested({ each: true })
  @Type(() => ChannelModelPriceDto)
  modelPrices?: ChannelModelPriceDto[];

  /** 渠道分组 id 列表（仅管理员可设置）；空 = 公共渠道，任何分组可见 */
  @IsOptional()
  @IsArray()
  @IsString({ each: true })
  @MaxLength(64, { each: true })
  groups?: string[];

  /** 上游计费分组名（如 TokenFleet 的 group_test），仅用于成本核算与展示 */
  @IsOptional()
  @IsString()
  @MaxLength(64)
  upstreamGroup?: string | null;

  /** 共享模式：PRIVATE 私有 / GROUP 同分组共享 / PUBLIC 公开共享 */
  @IsOptional()
  @IsEnum(ChannelShareMode)
  shareMode?: ChannelShareMode;

  /** 共享紧急度：NORMAL / HIGH / FLUSH（额度快过期时提高派发优先级） */
  @IsOptional()
  @IsEnum(ChannelShareUrgency)
  shareUrgency?: ChannelShareUrgency;

  /** 共享额度：折算上游成本上限（USD）；达到即自动停止接单 */
  @IsOptional()
  @IsNumber({ maxDecimalPlaces: 6 })
  @Min(0)
  shareQuotaCostUsd?: number | null;

  /** 共享额度：调用次数上限；达到即自动停止接单 */
  @IsOptional()
  @IsInt()
  @Min(0)
  shareQuotaRequests?: number | null;

  /** 共享到期时间（ISO）；到时自动停止接单 */
  @IsOptional()
  @IsISO8601()
  shareUntil?: string | null;

  /** 平台抽成基点（0-10000，仅管理员可设）；留空用全局默认 */
  @IsOptional()
  @IsInt()
  @Min(0)
  shareFeeBps?: number | null;
}
