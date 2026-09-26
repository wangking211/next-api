import {
  ArrayMaxSize,
  IsArray,
  IsOptional,
  IsString,
  MaxLength,
} from 'class-validator';

export class TestChannelDto {
  /** 可选：指定单个用于测试的模型 */
  @IsOptional()
  @IsString()
  @MaxLength(128)
  model?: string;

  /** 可选：批量测试多个模型（优先于 model） */
  @IsOptional()
  @IsArray()
  @ArrayMaxSize(20)
  @IsString({ each: true })
  models?: string[];
}
