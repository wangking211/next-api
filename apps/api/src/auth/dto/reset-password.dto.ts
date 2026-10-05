import { IsEmail, IsString, Matches, MaxLength, MinLength } from 'class-validator';

/** 用邮箱验证码设置新密码 */
export class ResetPasswordDto {
  @IsEmail()
  @MaxLength(120)
  email!: string;

  /** 6 位数字验证码；格式与有效性由服务端校验（统一返回 AUTH_CODE_INVALID 以便本地化） */
  @IsString()
  @MaxLength(16)
  code!: string;

  @IsString()
  @MinLength(8)
  @MaxLength(72)
  @Matches(/(?=.*[A-Za-z])(?=.*\d)/, {
    message: 'password must be at least 8 characters and include letters and numbers',
  })
  password!: string;
}
