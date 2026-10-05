import { IsEmail, IsOptional, IsString, Matches, MaxLength, MinLength } from 'class-validator';

export class RegisterDto {
  @IsEmail()
  @MaxLength(120)
  email!: string;

  @IsString()
  @MinLength(3)
  @MaxLength(32)
  @Matches(/^[a-zA-Z0-9_]+$/, {
    message: 'username may only contain letters, numbers and underscore',
  })
  username!: string;

  @IsString()
  @MinLength(8)
  @MaxLength(72)
  @Matches(/(?=.*[A-Za-z])(?=.*\d)/, {
    message: 'password must be at least 8 characters and include letters and numbers',
  })
  password!: string;

  /**
   * 邮箱验证码。是否必填由服务端按 SMTP 配置判定（未配置时不校验、不发送），
   * 因此这里只做类型约束，语义校验在 AuthService 里抛稳定错误码。
   */
  @IsOptional()
  @IsString()
  @MaxLength(16)
  emailCode?: string;
}
