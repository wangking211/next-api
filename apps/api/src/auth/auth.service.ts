import {
  ConflictException,
  HttpException,
  Injectable,
  UnauthorizedException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { JwtService } from '@nestjs/jwt';
import { Prisma, User } from '@prisma/client';
import * as bcrypt from 'bcryptjs';
import { UsersService } from '../users/users.service';
import { RedisService } from '../redis/redis.service';
import { RegisterDto } from './dto/register.dto';
import { LoginDto } from './dto/login.dto';

const BCRYPT_ROUNDS = 12;

export interface SafeUser {
  id: string;
  email: string;
  username: string;
  role: string;
  createdAt: Date;
}

@Injectable()
export class AuthService {
  private readonly loginFailLimit: number;
  private readonly loginFailWindow: number;

  constructor(
    private readonly users: UsersService,
    private readonly jwt: JwtService,
    private readonly redis: RedisService,
    config: ConfigService,
  ) {
    this.loginFailLimit = Number(config.get<string>('LOGIN_FAIL_LIMIT', '10'));
    this.loginFailWindow = Number(config.get<string>('LOGIN_FAIL_WINDOW', '300'));
  }

  private sanitize(user: User): SafeUser {
    return {
      id: user.id,
      email: user.email,
      username: user.username,
      role: user.role,
      createdAt: user.createdAt,
    };
  }

  private async sign(user: User) {
    const token = await this.jwt.signAsync({
      sub: user.id,
      email: user.email,
      username: user.username,
      role: user.role,
    });
    return { accessToken: token, user: this.sanitize(user) };
  }

  async register(dto: RegisterDto) {
    const email = dto.email.toLowerCase().trim();
    const [byEmail, byUsername] = await Promise.all([
      this.users.findByEmail(email),
      this.users.findByUsername(dto.username),
    ]);
    if (byEmail) throw new ConflictException('Email already registered');
    if (byUsername) throw new ConflictException('Username already taken');

    const passwordHash = await bcrypt.hash(dto.password, BCRYPT_ROUNDS);
    let user: User;
    try {
      user = await this.users.create({
        email,
        username: dto.username,
        passwordHash,
      });
    } catch (e) {
      // 并发/重复注册命中唯一约束时返回 409，而非 500
      if (e instanceof Prisma.PrismaClientKnownRequestError && e.code === 'P2002') {
        throw new ConflictException('Email or username already registered');
      }
      throw e;
    }
    return this.sign(user);
  }

  async login(dto: LoginDto) {
    const identifier = dto.identifier.trim();
    const throttleKey = `login:fail:${identifier.toLowerCase()}`;
    await this.assertLoginAllowed(throttleKey);

    const user = await this.users.findByEmailOrUsername(identifier);
    const ok = !!user && (await bcrypt.compare(dto.password, user.passwordHash));
    if (!ok) {
      await this.registerLoginFailure(throttleKey);
      throw new UnauthorizedException('Invalid credentials');
    }
    if (user!.status === 'BANNED') {
      throw new UnauthorizedException('Account is banned');
    }
    await this.clearLoginFailures(throttleKey);
    return this.sign(user!);
  }

  /** 登录失败次数限流（按账号标识），防止暴力破解。 */
  private async assertLoginAllowed(key: string): Promise<void> {
    if (this.loginFailLimit <= 0) return;
    try {
      const count = Number(await this.redis.client.get(key)) || 0;
      if (count >= this.loginFailLimit) {
        throw new HttpException(
          'Too many failed login attempts. Please try again later.',
          429,
        );
      }
    } catch (e) {
      if (e instanceof HttpException) throw e;
      // Redis 不可用时放行，不阻断登录
    }
  }

  private async registerLoginFailure(key: string): Promise<void> {
    if (this.loginFailLimit <= 0) return;
    try {
      const count = await this.redis.client.incr(key);
      if (count === 1) await this.redis.client.expire(key, this.loginFailWindow);
    } catch {
      /* ignore */
    }
  }

  private async clearLoginFailures(key: string): Promise<void> {
    try {
      await this.redis.client.del(key);
    } catch {
      /* ignore */
    }
  }

  async me(userId: string): Promise<SafeUser> {
    const user = await this.users.getOrThrow(userId);
    return this.sanitize(user);
  }
}
