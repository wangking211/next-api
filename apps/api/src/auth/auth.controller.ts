import { Body, Controller, Get, Post, Req, UseGuards } from '@nestjs/common';
import type { Request } from 'express';
import { AuthService } from './auth.service';
import { RegisterDto } from './dto/register.dto';
import { LoginDto } from './dto/login.dto';
import { EmailCodeDto } from './dto/email-code.dto';
import { ForgotPasswordDto } from './dto/forgot-password.dto';
import { ResetPasswordDto } from './dto/reset-password.dto';
import { JwtAuthGuard } from '../common/guards/jwt-auth.guard';
import { CurrentUser } from '../common/decorators/current-user.decorator';
import { AuthUser } from '../common/interfaces/auth.interface';

@Controller('auth')
export class AuthController {
  constructor(private readonly auth: AuthService) {}

  /**
   * 邮件通道状态（公开）：注册是否强制验证码、找回密码是否可用，
   * 前端按这个开关渲染验证码框与「忘记密码」入口，避免在未配置 SMTP 时展示死路。
   */
  @Get('mail-status')
  mailStatus() {
    return this.auth.mailStatus();
  }

  /** 请求邮箱验证码（注册 / 找回密码共用；带 IP 与冷却限流） */
  @Post('email-code')
  sendEmailCode(@Body() dto: EmailCodeDto, @Req() req: Request) {
    return this.auth.requestEmailCode(dto.email, dto.purpose, dto.locale, req.ip);
  }

  @Post('register')
  register(@Body() dto: RegisterDto, @Req() req: Request) {
    // IP 来源取自 req.ip：需配合 main.ts 的 trust proxy 才能拿到真实客户端 IP
    return this.auth.register(dto, req.ip);
  }

  @Post('login')
  login(@Body() dto: LoginDto, @Req() req: Request) {
    return this.auth.login(dto, req.ip);
  }

  /** 忘记密码第一步：发重置验证码（无论邮箱是否注册都返回同样的 200） */
  @Post('forgot-password')
  forgotPassword(@Body() dto: ForgotPasswordDto, @Req() req: Request) {
    return this.auth.requestEmailCode(dto.email, 'reset', dto.locale, req.ip);
  }

  /** 忘记密码第二步：验证码 + 新密码；成功后该账号所有已签发令牌立即失效 */
  @Post('reset-password')
  async resetPassword(@Body() dto: ResetPasswordDto) {
    await this.auth.resetPassword(dto.email, dto.code, dto.password);
    return { ok: true };
  }

  @UseGuards(JwtAuthGuard)
  @Get('me')
  me(@CurrentUser() user: AuthUser) {
    return this.auth.me(user.id);
  }

  /**
   * 退出全部设备：自增 tokenVersion，使该用户名下所有已签发令牌立即失效
   * （包括调用本接口的这一个）。用于密钥/令牌疑似泄露后的快速止损。
   */
  @UseGuards(JwtAuthGuard)
  @Post('logout-all')
  logoutAll(@CurrentUser() user: AuthUser) {
    return this.auth.revokeAllSessions(user.id);
  }
}
