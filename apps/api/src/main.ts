import { NestFactory } from '@nestjs/core';
import { ValidationPipe, Logger, RequestMethod } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { json, urlencoded } from 'express';
import helmet from 'helmet';
import { AppModule } from './app.module';
import { BootstrapService } from './auth/bootstrap.service';

const INSECURE_JWT = ['change-me', 'change-me-in-production', ''];

function assertProductionSecrets(config: ConfigService) {
  if (config.get<string>('NODE_ENV') !== 'production') return;
  const jwt = config.get<string>('JWT_SECRET', '');
  const enc = config.get<string>('ENCRYPTION_KEY', '');
  const errors: string[] = [];
  if (INSECURE_JWT.includes(jwt)) errors.push('JWT_SECRET 必须设置为强随机值');
  if (!/^[0-9a-fA-F]{64}$/.test(enc) || /^0+$/.test(enc)) {
    errors.push('ENCRYPTION_KEY 必须为 32 字节非全零 hex');
  }
  if (errors.length) {
    throw new Error(`生产环境配置不安全：\n- ${errors.join('\n- ')}`);
  }
}

async function bootstrap() {
  const app = await NestFactory.create(AppModule, { bodyParser: false });
  const config = app.get(ConfigService);

  assertProductionSecrets(config);

  app.use(helmet());
  app.use(json({ limit: '25mb' }));
  app.use(urlencoded({ extended: true, limit: '25mb' }));

  // 控制台 API 走 /api 前缀；OpenAI 兼容网关走 /v1
  app.setGlobalPrefix('api', {
    exclude: [
      { path: 'v1/chat/completions', method: RequestMethod.POST },
      { path: 'v1/models', method: RequestMethod.GET },
    ],
  });

  const corsOrigin = config.get<string>('CORS_ORIGIN', '*');
  app.enableCors({
    origin: corsOrigin === '*' ? true : corsOrigin.split(',').map((o) => o.trim()),
    credentials: true,
  });

  app.useGlobalPipes(
    new ValidationPipe({
      whitelist: true,
      transform: true,
      forbidNonWhitelisted: false,
    }),
  );

  await app.get(BootstrapService).ensureAdmin();

  app.enableShutdownHooks();

  const port = config.get<number>('PORT', 3000);
  await app.listen(port);
  Logger.log(`API listening on http://localhost:${port}/api`, 'Bootstrap');
  Logger.log(`Gateway listening on http://localhost:${port}/v1`, 'Bootstrap');
}

bootstrap();
