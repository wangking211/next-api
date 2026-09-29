import { NestFactory } from '@nestjs/core';
import { ValidationPipe, Logger, RequestMethod } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { json, urlencoded } from 'express';
import helmet from 'helmet';
import { DocumentBuilder, SwaggerModule } from '@nestjs/swagger';
import { AppModule } from './app.module';
import { BootstrapService } from './auth/bootstrap.service';
import { assertProdJwtSecret } from './auth/jwt-secret';

function assertProductionSecrets(config: ConfigService) {
  if (config.get<string>('NODE_ENV') !== 'production') return;
  const enc = config.get<string>('ENCRYPTION_KEY', '');
  const errors: string[] = [];
  // JWT 密钥同源校验（与 JwtModule 解析共用一套规则）：占位符/过短/低熵 → 启动失败
  try {
    assertProdJwtSecret(config.get<string>('JWT_SECRET') ?? '');
  } catch (e: any) {
    errors.push(e.message);
  }
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

  // 控制台 API 走 /api 前缀；OpenAI 兼容网关走 /v1；Anthropic 兼容网关走 /v1/messages
  app.setGlobalPrefix('api', {
    exclude: [
      { path: 'v1/chat/completions', method: RequestMethod.POST },
      { path: 'v1/models', method: RequestMethod.GET },
      { path: 'v1/messages', method: RequestMethod.POST },
    ],
  });

  const corsOrigin = config.get<string>('CORS_ORIGIN', '').trim();
  const isProd = config.get<string>('NODE_ENV') === 'production';
  if (corsOrigin && corsOrigin !== '*') {
    app.enableCors({
      origin: corsOrigin
        .split(',')
        .map((o) => o.trim())
        .filter(Boolean),
      credentials: true,
    });
  } else if (isProd) {
    // 生产未显式配置来源时关闭跨域（同源请求不受影响），避免反射任意 Origin + credentials
    app.enableCors({ origin: false });
  } else {
    app.enableCors({ origin: true, credentials: true });
  }

  app.useGlobalPipes(
    new ValidationPipe({
      whitelist: true,
      transform: true,
      forbidNonWhitelisted: false,
    }),
  );

  await app.get(BootstrapService).ensureAdmin();

  // Swagger 文档（/api/docs，自带 Try it out 交互式调用）
  const swaggerConfig = new DocumentBuilder()
    .setTitle('AI Gateway API')
    .setDescription(
      '控制台 API（/api/**，JWT Bearer）与 OpenAI 兼容网关（/v1/**，sk- API Key）。' +
        '网关端点支持 Authorization: Bearer sk-... 与 x-api-key: sk-... 两种鉴权。',
    )
    .setVersion('1.0')
    .addBearerAuth(
      { type: 'http', scheme: 'bearer', description: 'JWT（控制台 API）或 sk- API Key（网关）' },
      'bearer',
    )
    .build();
  const swaggerDocument = SwaggerModule.createDocument(app, swaggerConfig);
  SwaggerModule.setup('api/docs', app, swaggerDocument, {
    customSiteTitle: 'AI Gateway API Docs',
    swaggerOptions: {
      persistAuthorization: true,
      deepLinking: true,
      docExpansion: 'list',
      tagsSorter: 'alpha',
      operationsSorter: 'alpha',
    },
  });

  app.enableShutdownHooks();

  const port = config.get<number>('PORT', 3000);
  await app.listen(port);
  Logger.log(`API listening on http://localhost:${port}/api`, 'Bootstrap');
  Logger.log(`Gateway listening on http://localhost:${port}/v1`, 'Bootstrap');
}

bootstrap();
