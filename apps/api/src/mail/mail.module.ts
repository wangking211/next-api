import { Module } from '@nestjs/common';
import { MailService } from './mail.service';
import { SmtpMailService } from './smtp-mail.service';

/**
 * 邮件通道模块：业务侧只注入抽象 `MailService`。
 * 换实现（Resend / SendGrid …）时把下面的 `useClass` 换掉即可。
 */
@Module({
  providers: [{ provide: MailService, useClass: SmtpMailService }],
  exports: [MailService],
})
export class MailModule {}
