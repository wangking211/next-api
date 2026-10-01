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
  private readonly loginIpLimit: number;
  private readonly loginIpWindow: number;

  constructor(
    private readonly users: UsersService,
    private readonly jwt: JwtService,
    private readonly redis: RedisService,
    config: ConfigService,
  ) {
    this.loginFailLimit = Number(config.get<string>('LOGIN_FAIL_LIMIT', '10'));
    this.loginFailWindow = Number(config.get<string>('LOGIN_FAIL_WINDOW', '300'));
    // IP 维度兜底：按账号的失败限流挡不住「换账号轮换撞库」
    this.loginIpLimit = Number(config.get<string>('LOGIN_IP_LIMIT', '30'));
    this.loginIpWindow = Number(config.get<string>('LOGIN_IP_WINDOW', '300'));
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
      // 令牌版本随签发写入：tokenVersion 变更后旧 token 立即失效
      tv: user.tokenVersion ?? 0,
    });
    return { accessToken: token, user: this.sanitize(user) };
  }

  /**
   * 吊销该用户名下**已签发的所有令牌**（退出全部设备/强制下线）。
   * JWT 本身无状态，靠 tokenVersion 自增让旧 `tv` 失效；下次请求的守卫比对即 401。
   */
  async revokeAllSessions(userId: string): Promise<SafeUser> {
    const user = await this.users.getOrThrow(userId);
    await this.users.incrementTokenVersion(userId);
    return this.sanitize(user);
  }

  async register(dto: RegisterDto, ip?: string) {
    // 同一来源 IP 短时间内批量注册（薅免费额度/垃圾账号）由 IP 维度兜底
    await this.assertLoginIpAllowed(ip);
    await this.hitLoginIp(ip);
    const email = dto.email.toLowerCase().trim();
    const [byEmail, byUsername] = await Promise.all([
      this.users.findByEmail(email),
      this.users.findByUsernameInsensitive(dto.username),
    ]);
    if (byEmail) {
      throw new ConflictException({ code: 'AUTH_EMAIL_TAKEN', message: 'Email already registered' });
    }
    if (byUsername) {
      throw new ConflictException({ code: 'AUTH_USERNAME_TAKEN', message: 'Username already taken' });
    }

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
        throw new ConflictException({
          code: 'AUTH_IDENTIFIER_TAKEN',
          message: 'Email or username already registered',
        });
      }
      throw e;
    }
    return this.sign(user);
  }

  async login(dto: LoginDto, ip?: string) {
    await this.assertLoginIpAllowed(ip);
    const identifier = dto.identifier.trim();
    const throttleKey = `login:fail:${identifier.toLowerCase()}`;
    await this.assertLoginAllowed(throttleKey);
    // 无论成败都计一次：防止换着账号从同一 IP 轮换试密
    await this.hitLoginIp(ip);

    const user = await this.users.findByEmailOrUsername(identifier);
    const ok = !!user && (await bcrypt.compare(dto.password, user.passwordHash));
    if (!ok) {
      await this.registerLoginFailure(throttleKey);
      throw new UnauthorizedException({
        code: 'AUTH_INVALID_CREDENTIALS',
        message: 'Invalid credentials',
      });
    }
    if (user!.status === 'BANNED') {
      throw new UnauthorizedException({
        code: 'AUTH_ACCOUNT_BANNED',
        message: 'Account is banned',
      });
    }
    await this.clearLoginFailures(throttleKey);
    // 登录也计入「最后活跃」（尽力而为，内部已吞错，失败不影响登录）
    await this.users.touchLastActive(user!.id);
    return this.sign(user!);
  }

  /** 登录失败次数限流（按账号标识），防止暴力破解。 */
  private async assertLoginAllowed(key: string): Promise<void> {
    if (this.loginFailLimit <= 0) return;
    try {
      const count = Number(await this.redis.client.get(key)) || 0;
      if (count >= this.loginFailLimit) {
        throw new HttpException(
          {
            code: 'AUTH_TOO_MANY_ATTEMPTS',
            message: 'Too many failed login attempts. Please try again later.',
          },
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

  /** 来源 IP 维度的登录/注册尝试限流；Redis 不可用时放行（与账号维度同容错策略）。 */
  private async assertLoginIpAllowed(ip?: string): Promise<void> {
    if (!ip || this.loginIpLimit <= 0) return;
    try {
      const count = Number(await this.redis.client.get(`login:ip:${ip}`)) || 0;
      if (count >= this.loginIpLimit) {
        throw new HttpException(
          {
            code: 'AUTH_IP_THROTTLED',
            message: 'Too many requests from your IP. Please try again later.',
          },
          429,
        );
      }
    } catch (e) {
      if (e instanceof HttpException) throw e;
      // Redis 不可用时放行，不阻断登录
    }
  }

  private async hitLoginIp(ip?: string): Promise<void> {
    if (!ip || this.loginIpLimit <= 0) return;
    try {
      const key = `login:ip:${ip}`;
      const count = await this.redis.client.incr(key);
      if (count === 1) await this.redis.client.expire(key, this.loginIpWindow);
    } catch {
      /* ignore */
    }
  }

  async me(userId: string): Promise<SafeUser> {
    const user = await this.users.getOrThrow(userId);
    return this.sanitize(user);
  }
}
