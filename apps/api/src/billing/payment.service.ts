import {
  BadRequestException,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { BalanceTxType, PaymentOrderStatus, Role } from '@prisma/client';
import { randomBytes } from 'crypto';
import { PrismaService } from '../prisma/prisma.service';
import { AuthUser } from '../common/interfaces/auth.interface';
import { jaiPaySign, jaiPayVerify } from './jai-pay.sign';

/** 允许的支付方式（JAIPay wayCode） */
const ALLOWED_WAY_CODES = new Set([
  'QR_CASHIER',
  'WX_NATIVE',
  'ALI_QR',
  'WX_H5',
  'ALI_WAP',
  'WX_JSAPI',
  'ALI_JSAPI',
]);
const DEFAULT_WAY_CODE = 'QR_CASHIER';

function round(value: number, digits: number): number {
  const f = 10 ** digits;
  return Math.round(value * f) / f;
}

/** reqTime 格式：yyyyMMddHHmmss（本地时间） */
function formatReqTime(d: Date): string {
  const p = (n: number) => String(n).padStart(2, '0');
  return (
    `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}` +
    `${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`
  );
}

type JaiPayConfig = {
  baseUrl: string;
  mchNo: string;
  appId: string;
  appSecret: string;
  notifyUrl: string;
  returnUrl: string;
  cnyPerUsd: number;
  creditsPerUsd: number;
};

/**
 * 在线充值（微信/支付宝，经 JAIPay 网关）。
 * 下单 → 前端展示二维码/跳转收银台 → JAIPay 异步回调 → 验签 + 幂等入账。
 */
@Injectable()
export class PaymentService {
  private readonly logger = new Logger(PaymentService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly config: ConfigService,
  ) {}

  /** 在线支付是否已配置（三项密钥齐全） */
  isConfigured(): boolean {
    return Boolean(
      this.config.get<string>('JAIPAY_MCH_NO') &&
        this.config.get<string>('JAIPAY_APP_ID') &&
        this.config.get<string>('JAIPAY_APP_SECRET'),
    );
  }

  /** 每 1 元人民币可充入的积分（= CREDITS_PER_USD / PAY_CNY_PER_USD） */
  creditsPerCny(): number {
    const cfg = this.rawRate();
    return round(cfg.creditsPerUsd / cfg.cnyPerUsd, 2);
  }

  private rawRate() {
    const cnyPerUsd = Number(this.config.get<string>('PAY_CNY_PER_USD', '7.1')) || 7.1;
    const creditsPerUsd = Number(this.config.get<string>('CREDITS_PER_USD', '100')) || 100;
    return { cnyPerUsd, creditsPerUsd };
  }

  private jaiPayConfig(): JaiPayConfig {
    if (!this.isConfigured()) {
      throw new BadRequestException('在线支付未开通，请联系管理员或使用兑换码充值');
    }
    const { cnyPerUsd, creditsPerUsd } = this.rawRate();
    return {
      baseUrl: (
        this.config.get<string>('JAIPAY_BASE_URL', 'https://pay.zxixing.com') || ''
      ).replace(/\/+$/, ''),
      mchNo: this.config.get<string>('JAIPAY_MCH_NO', '') as string,
      appId: this.config.get<string>('JAIPAY_APP_ID', '') as string,
      appSecret: this.config.get<string>('JAIPAY_APP_SECRET', '') as string,
      notifyUrl:
        this.config.get<string>('JAIPAY_NOTIFY_URL', '') ||
        'https://xiaopuyun.com/api/pay/jai/notify',
      returnUrl: this.config.get<string>('JAIPAY_RETURN_URL', '') || '',
      cnyPerUsd,
      creditsPerUsd,
    };
  }

  /** 创建充值订单：本地落单 → 调 JAIPay 统一下单 → 返回支付数据（二维码内容/跳转链接） */
  async createOrder(user: AuthUser, amountCents: number, wayCode?: string) {
    const cfg = this.jaiPayConfig();
    const code = (wayCode || DEFAULT_WAY_CODE).toUpperCase();
    if (!ALLOWED_WAY_CODES.has(code)) {
      throw new BadRequestException('不支持的支付方式');
    }

    const creditUsd = round(amountCents / 100 / cfg.cnyPerUsd, 6);
    const credits = round(creditUsd * cfg.creditsPerUsd, 2);
    const mchOrderNo = `PAY${Date.now()}${randomBytes(3).toString('hex').toUpperCase()}`;

    const order = await this.prisma.paymentOrder.create({
      data: {
        userId: user.id,
        mchOrderNo,
        wayCode: code,
        amountCents,
        creditUsd,
        credits,
      },
    });

    const payload: Record<string, unknown> = {
      mchNo: cfg.mchNo,
      appId: cfg.appId,
      mchOrderNo,
      wayCode: code,
      amount: amountCents,
      currency: 'cny',
      subject: `AI Gateway 充值 ¥${(amountCents / 100).toFixed(2)}`,
      body: `充值 ${credits} 积分`,
      notifyUrl: cfg.notifyUrl,
      reqTime: formatReqTime(new Date()),
      version: '1.0',
      signType: 'MD5',
    };
    if (cfg.returnUrl) payload.returnUrl = cfg.returnUrl;
    payload.sign = jaiPaySign(payload, cfg.appSecret);

    let res: Awaited<ReturnType<typeof fetch>>;
    try {
      res = await fetch(`${cfg.baseUrl}/api/pay/unifiedOrder`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
        signal: AbortSignal.timeout(15000),
      });
    } catch (e) {
      await this.markFailed(order.id);
      throw new BadRequestException(
        `无法连接支付网关: ${e instanceof Error ? e.message : String(e)}`,
      );
    }

    const json: any = await res.json().catch(() => null);
    if (!res.ok || !json || json.code !== 0) {
      await this.markFailed(order.id);
      throw new BadRequestException(
        `下单失败（${json?.code ?? res.status}）: ${json?.msg ?? res.statusText}`,
      );
    }

    const data = json.data ?? {};
    await this.prisma.paymentOrder.update({
      where: { id: order.id },
      data: { payOrderId: data.payOrderId ?? null },
    });

    return {
      id: order.id,
      mchOrderNo,
      amountCents,
      creditUsd,
      credits,
      wayCode: code,
      payDataType: data.payDataType ?? null,
      payData: data.payData ?? null,
      status: order.status,
    };
  }

  /** 我的充值订单（最近 N 条） */
  async listOrders(user: AuthUser, limit = 10) {
    const take = Math.min(Math.max(Number(limit) || 10, 1), 50);
    const items = await this.prisma.paymentOrder.findMany({
      where: { userId: user.id },
      orderBy: { createdAt: 'desc' },
      take,
    });
    return { items: items.map((o) => this.view(o)) };
  }

  /** 单笔订单状态（前端轮询用） */
  async getOrder(user: AuthUser, id: string) {
    const order = await this.prisma.paymentOrder.findUnique({ where: { id } });
    if (!order || (order.userId !== user.id && user.role !== Role.ADMIN)) {
      throw new NotFoundException('订单不存在');
    }
    return this.view(order);
  }

  /**
   * JAIPay 异步通知：验签 → 校验状态/金额 → 幂等入账。
   * 返回 skipped 表示「已接收但无需处理」，调用方仍应回 200。
   */
  async handleNotify(query: Record<string, string>) {
    const cfg = this.jaiPayConfig();
    if (!jaiPayVerify(query, cfg.appSecret)) {
      this.logger.warn(`支付回调签名校验失败: ${JSON.stringify(query).slice(0, 500)}`);
      throw new BadRequestException('签名校验失败');
    }

    const mchOrderNo = query.mchOrderNo ?? '';
    if (query.state !== '2') {
      this.logger.log(`支付回调非成功状态（state=${query.state}）: ${mchOrderNo}`);
      return { ok: true, skipped: 'state' };
    }

    const order = await this.prisma.paymentOrder.findUnique({
      where: { mchOrderNo },
    });
    if (!order) {
      this.logger.error(`支付回调订单不存在: ${mchOrderNo}`);
      return { ok: true, skipped: 'unknown-order' };
    }

    const paidCents = Number(query.amount);
    if (Number.isFinite(paidCents) && paidCents !== order.amountCents) {
      this.logger.error(
        `支付金额不一致: 订单 ${mchOrderNo} 期望 ${order.amountCents} 分，回调 ${paidCents} 分`,
      );
      return { ok: true, skipped: 'amount-mismatch' };
    }
    if (order.status === PaymentOrderStatus.PAID) {
      return { ok: true, skipped: 'duplicate' };
    }

    const successAt = Number(query.successTime);
    await this.prisma.$transaction(async (tx) => {
      const claimed = await tx.paymentOrder.updateMany({
        where: { id: order.id, status: PaymentOrderStatus.PENDING },
        data: {
          status: PaymentOrderStatus.PAID,
          payOrderId: query.payOrderId ?? order.payOrderId,
          channel: query.ifCode ?? null,
          channelOrderNo: query.channelOrderNo ?? null,
          paidAt:
            Number.isFinite(successAt) && successAt > 0
              ? new Date(successAt)
              : new Date(),
          notifyRaw: JSON.stringify(query).slice(0, 4000),
        },
      });
      if (claimed.count !== 1) return; // 并发下已被其它回调处理

      const credit = Number(order.creditUsd);
      const updated = await tx.user.update({
        where: { id: order.userId },
        data: { balance: { increment: credit } },
        select: { balance: true },
      });
      await tx.balanceTransaction.create({
        data: {
          userId: order.userId,
          type: BalanceTxType.RECHARGE,
          amount: credit,
          balanceAfter: round(Number(updated.balance), 6),
          description: `在线充值 ¥${(order.amountCents / 100).toFixed(2)}（${order.wayCode}）`,
        },
      });
    });

    this.logger.log(
      `在线充值到账: ${mchOrderNo} +${order.creditUsd} USD（${order.credits} 积分）`,
    );
    return { ok: true };
  }

  private async markFailed(id: string) {
    try {
      await this.prisma.paymentOrder.update({
        where: { id },
        data: { status: PaymentOrderStatus.FAILED },
      });
    } catch {
      /* 订单状态更新失败不影响下单错误返回 */
    }
  }

  private view(o: {
    id: string;
    mchOrderNo: string;
    wayCode: string;
    channel: string | null;
    channelOrderNo: string | null;
    amountCents: number;
    creditUsd: unknown;
    credits: unknown;
    status: PaymentOrderStatus;
    paidAt: Date | null;
    createdAt: Date;
  }) {
    return {
      id: o.id,
      mchOrderNo: o.mchOrderNo,
      wayCode: o.wayCode,
      channel: o.channel,
      channelOrderNo: o.channelOrderNo,
      amountCents: o.amountCents,
      creditUsd: Number(o.creditUsd),
      credits: Number(o.credits),
      status: o.status,
      paidAt: o.paidAt,
      createdAt: o.createdAt,
    };
  }
}
