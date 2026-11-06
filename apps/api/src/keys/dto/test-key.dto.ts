import { IsOptional, IsString, MaxLength } from 'class-validator';

export class TestKeyDto {
  /** 要测试的模型；留空 = 该 Key 白名单首个 / 当前可路由首个模型 */
  @IsOptional()
  @IsString()
  @MaxLength(128)
  model?: string;
}
