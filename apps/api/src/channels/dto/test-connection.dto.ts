import {
  ArrayMaxSize,
  IsArray,
  IsOptional,
  IsString,
  IsUrl,
  MaxLength,
  MinLength,
} from 'class-validator';

export class TestConnectionDto {
  @IsString()
  @MinLength(1)
  @MaxLength(32)
  provider!: string;

  @IsUrl({ require_tld: false })
  @MaxLength(255)
  baseUrl!: string;

  @IsOptional()
  @IsString()
  @MaxLength(128)
  model?: string;

  @IsOptional()
  @IsArray()
  @ArrayMaxSize(20)
  @IsString({ each: true })
  models?: string[];

  @IsOptional()
  @IsString()
  @MaxLength(512)
  apiKey?: string;

  /** 编辑已有渠道时可不填 apiKey，复用已存密钥 */
  @IsOptional()
  @IsString()
  channelId?: string;
}
