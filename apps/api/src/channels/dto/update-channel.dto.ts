import {
  ArrayMaxSize,
  ArrayMinSize,
  IsArray,
  IsBoolean,
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
  ValidateNested,
} from 'class-validator';
import { Type } from 'class-transformer';
import { ChannelShareMode, ChannelShareUrgency, ChannelStatus } from '@prisma/client';
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
  // 数量与单项长度双重封顶：防超大数组/超长字符串撑爆内存与模型行 upsert
  @ArrayMaxSize(1000)
  @IsString({ each: true })
  @MaxLength(256, { each: true })
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
  @ArrayMaxSize(1000)
  @ValidateNested({ each: true })
  @Type(() => ChannelModelPriceDto)
  modelPrices?: ChannelModelPriceDto[];

  /**
   * 渠道分组 id 列表：管理员可绑任意分组；非管理员仅限本人所在分组
   * （同分组共享，服务端 enforce）。空数组 = 解除全部绑定
   */
  @IsOptional()
  @IsArray()
  @ArrayMaxSize(100)
  @IsString({ each: true })
  @MaxLength(64, { each: true })
  groups?: string[];

  /** 上游计费分组名（仅用于成本核算与展示） */
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

  /**
   * 重置共享已用用量（shareUsedRequests / shareUsedCostUsd 归零）。
   * 与「shareUntil 延长」任一命中即清零，二者同时命中也只清零一次；
   * 不影响累计分成 shareRevenue。
   */
  @IsOptional()
  @IsBoolean()
  resetShareUsed?: boolean;

  /** 平台抽成基点（0-10000，仅管理员可设）；留空用全局默认 */
  @IsOptional()
  @IsInt()
  @Min(0)
  shareFeeBps?: number | null;
}
