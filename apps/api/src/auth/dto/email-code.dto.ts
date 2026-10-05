import { IsEmail, IsIn, IsOptional, IsString, MaxLength } from 'class-validator';

/** 请求发送邮箱验证码（注册 / 找回密码共用） */
export class EmailCodeDto {
  @IsEmail()
  @MaxLength(120)
  email!: string;

  @IsIn(['register', 'reset'])
  purpose!: 'register' | 'reset';

  /** 界面语言（zh-CN / zh-Hant / en），决定邮件文案；缺省按简体中文 */
  @IsOptional()
  @IsString()
  @MaxLength(16)
  locale?: string;
}
