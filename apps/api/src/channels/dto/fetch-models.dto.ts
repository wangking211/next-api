import { IsOptional, IsString, IsUrl, MaxLength, MinLength } from 'class-validator';

/** 拉取上游可用模型列表（渠道表单「获取上游模型」按钮） */
export class FetchModelsDto {
  @IsString()
  @MinLength(1)
  @MaxLength(32)
  provider!: string;

  /** 未提供 channelId 时必填；编辑已存渠道时可省略，复用渠道配置 */
  @IsOptional()
  @IsUrl({ require_tld: false })
  @MaxLength(255)
  baseUrl?: string;

  /** 未提供 channelId 时必填；编辑已存渠道时可省略，复用已存密钥 */
  @IsOptional()
  @IsString()
  @MaxLength(512)
  apiKey?: string;

  @IsOptional()
  @IsString()
  @MaxLength(64)
  channelId?: string;
}
