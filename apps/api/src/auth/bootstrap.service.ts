import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Role } from '@prisma/client';
import * as bcrypt from 'bcryptjs';
import { UsersService } from '../users/users.service';

/** 常见弱口令：生产环境 bootstrap 拒绝使用 */
const WEAK_PASSWORDS = new Set([
  'admin123456',
  'admin123',
  'adminadmin',
  'administrator',
  'password',
  'password123',
  'passw0rd',
  '123456789',
  '1234567890',
  'qwerty123',
  'admin@123',
  'aigw123456',
]);

/**
 * 生产环境 bootstrap 管理员口令策略：≥12 字符，且不属于常见弱口令/单一重复字符。
 * 不满足则抛错 → 启动失败（fail-fast），避免默认口令 admin123456 直接暴露在公网登录接口。
 */
export function assertStrongBootstrapPassword(raw: string): void {
  const v = (raw ?? '').trim();
  const problems: string[] = [];
  if (v.length < 12) problems.push('长度至少 12 字符');
  if (WEAK_PASSWORDS.has(v.toLowerCase())) problems.push('不得使用常见弱口令');
  if (/^(.)\1+$/.test(v)) problems.push('熵不足（单一重复字符）');
  if (problems.length) {
    throw new Error(`BOOTSTRAP_ADMIN_PASSWORD 不安全：${problems.join('；')}`);
  }
}

@Injectable()
export class BootstrapService {
  private readonly logger = new Logger(BootstrapService.name);

  constructor(
    private readonly config: ConfigService,
    private readonly users: UsersService,
  ) {}

  async ensureAdmin(): Promise<void> {
    const email = this.config.get<string>('BOOTSTRAP_ADMIN_EMAIL');
    const username = this.config.get<string>('BOOTSTRAP_ADMIN_USERNAME');
    const password = this.config.get<string>('BOOTSTRAP_ADMIN_PASSWORD');
    if (!email || !username || !password) return;

    // 生产环境先过口令策略，再执行创建（管理员已存在时同样校验配置，
    // 保证 .env 里的弱口令在启动阶段就暴露，而不是在重建管理员时才生效）
    if (this.config.get<string>('NODE_ENV') === 'production') {
      assertStrongBootstrapPassword(password);
    }

    const existing = await this.users.findByEmail(email.toLowerCase());
    if (existing) {
      if (existing.role !== Role.ADMIN) {
        this.logger.warn(`Bootstrap admin email ${email} exists but is not ADMIN`);
      }
      return;
    }

    const passwordHash = await bcrypt.hash(password, 12);
    await this.users.create({
      email: email.toLowerCase(),
      username,
      passwordHash,
      role: Role.ADMIN,
    });
    this.logger.log(`Bootstrap admin created: ${email} (username: ${username})`);
  }
}
