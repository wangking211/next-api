import { IsString, Matches, MaxLength, MinLength } from 'class-validator';

/** 管理员为指定用户重置登录密码（忘记密码自助流程不可用时的运维手段） */
export class AdminResetPasswordDto {
  @IsString()
  @MinLength(8)
  @MaxLength(72)
  @Matches(/(?=.*[A-Za-z])(?=.*\d)/, {
    message: 'password must be at least 8 characters and include letters and numbers',
  })
  password!: string;
}
