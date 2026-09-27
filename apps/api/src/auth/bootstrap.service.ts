import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Role } from '@prisma/client';
import * as bcrypt from 'bcryptjs';
import { UsersService } from '../users/users.service';

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
