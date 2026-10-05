import { IsEmail, IsOptional, IsString, MaxLength } from 'class-validator';

/** 忘记密码：请求把重置验证码发到该邮箱 */
export class ForgotPasswordDto {
  @IsEmail()
  @MaxLength(120)
  email!: string;

  /** 界面语言，决定邮件文案 */
  @IsOptional()
  @IsString()
  @MaxLength(16)
  locale?: string;
}
