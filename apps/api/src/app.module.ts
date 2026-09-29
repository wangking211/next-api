import { Module } from '@nestjs/common';
import { ConfigModule, ConfigService } from '@nestjs/config';
import { JwtModule } from '@nestjs/jwt';
import { join } from 'path';
import { PrismaModule } from './prisma/prisma.module';
import { RedisModule } from './redis/redis.module';
import { CommonModule } from './common/common.module';
import { AuthModule } from './auth/auth.module';
import { resolveJwtSecret } from './auth/jwt-secret';
import { UsersModule } from './users/users.module';
import { KeysModule } from './keys/keys.module';
import { ChannelsModule } from './channels/channels.module';
import { ModelsModule } from './models/models.module';
import { GroupsModule } from './groups/groups.module';
import { HealthModule } from './health/health.module';
import { PublicModule } from './public/public.module';
import { GatewayModule } from './gateway/gateway.module';
import { UsageModule } from './usage/usage.module';
import { BillingModule } from './billing/billing.module';
import { AuditModule } from './audit/audit.module';
import { AgentModule } from './agent/agent.module';
import { WithdrawalModule } from './billing/withdrawal.module';
import { PaymentModule } from './billing/payment.module';

@Module({
  imports: [
    ConfigModule.forRoot({
      isGlobal: true,
      envFilePath: [
        join(process.cwd(), '.env'),
        join(process.cwd(), 'apps/api/.env'),
      ],
    }),
    JwtModule.registerAsync({
      global: true,
      inject: [ConfigService],
      useFactory: (config: ConfigService) => ({
        // 无回退占位符：生产环境弱密钥直接启动失败；非生产缺失时生成随机密钥
        secret: resolveJwtSecret(
          config.get<string>('JWT_SECRET'),
          config.get<string>('NODE_ENV') === 'production',
        ),
        signOptions: { expiresIn: config.get<string>('JWT_EXPIRES_IN', '7d') },
      }),
    }),
    PrismaModule,
    RedisModule,
    CommonModule,
    AuthModule,
    UsersModule,
    KeysModule,
    ChannelsModule,
    ModelsModule,
    GroupsModule,
    HealthModule,
    PublicModule,
    GatewayModule,
    UsageModule,
    BillingModule,
    AuditModule,
    AgentModule,
    WithdrawalModule,
    PaymentModule,
  ],
})
export class AppModule {}
