import {
  ConflictException,
  Injectable,
  UnauthorizedException,
} from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import { User } from '@prisma/client';
import * as bcrypt from 'bcryptjs';
import { UsersService } from '../users/users.service';
import { RegisterDto } from './dto/register.dto';
import { LoginDto } from './dto/login.dto';

export interface SafeUser {
  id: string;
  email: string;
  username: string;
  role: string;
  createdAt: Date;
}

@Injectable()
export class AuthService {
  constructor(
    private readonly users: UsersService,
    private readonly jwt: JwtService,
  ) {}

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

    const passwordHash = await bcrypt.hash(dto.password, 10);
    const user = await this.users.create({
      email,
      username: dto.username,
      passwordHash,
    });
    return this.sign(user);
  }

  async login(dto: LoginDto) {
    const user = await this.users.findByEmailOrUsername(dto.identifier.trim());
    if (!user) throw new UnauthorizedException('Invalid credentials');
    const ok = await bcrypt.compare(dto.password, user.passwordHash);
    if (!ok) throw new UnauthorizedException('Invalid credentials');
    if (user.status === 'BANNED') {
      throw new UnauthorizedException('Account is banned');
    }
    return this.sign(user);
  }

  async me(userId: string): Promise<SafeUser> {
    const user = await this.users.getOrThrow(userId);
    return this.sanitize(user);
  }
}
