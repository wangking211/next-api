import { NestFactory } from '@nestjs/core';
import { ValidationPipe, Logger, RequestMethod } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { json, urlencoded } from 'express';
import type { NextFunction, Request, Response } from 'express';
import { openaiError } from './gateway/types';
import { toAnthropicErrorBody } from './gateway/anthropic-format';
import { openaiTypeFor } from './gateway/gateway-error.filter';
import helmet from 'helmet';
import { DocumentBuilder, SwaggerModule } from '@nestjs/swagger';
import { AppModule } from './app.module';
import { BootstrapService } from './auth/bootstrap.service';
import { assertProdJwtSecret } from './auth/jwt-secret';
import { requestIdMiddleware } from './common/request-id';
import { MetricsService } from './observability/metrics.service';

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

/** TRUST_PROXY 解析：true / false / 跳数（数字） / 网段（如 172.16.0.0/12），交由 express 信任判定 */
function parseTrustProxy(raw: string | undefined): boolean | number | string {
  const v = (raw ?? '').trim();
  if (v === 'true') return true;
  if (v === 'false' || v === '') return false;
  if (/^\d+$/.test(v)) return Number(v);
  return v;
}

async function bootstrap() {
  const app = await NestFactory.create(AppModule, { bodyParser: false });
  const config = app.get(ConfigService);

  assertProductionSecrets(config);

  app.use(helmet());
  // 请求关联：回显合法的入站 x-request-id，否则生成 UUID（响应头统一带回，
  // 未处理异常日志带 [rid=...]，客户端报错可凭 id 定位日志）
  app.use(requestIdMiddleware);
  // HTTP 指标：按路由模板（非原始 URL，防高基数）记录次数与耗时，Prometheus 抓取 /api/metrics
  const metrics = app.get(MetricsService);
  app.use((req: Request, res: Response, next: NextFunction) => {
    const start = process.hrtime.bigint();
    res.on('finish', () => {
      const raw = (req as unknown as { route?: { path?: string | string[] } }).route?.path;
      const route = Array.isArray(raw) ? raw[0] : raw;
      metrics.observeHttp(
        req.method,
        route ?? '__unmatched__',
        res.statusCode,
        Number(process.hrtime.bigint() - start) / 1e9,
      );
    });
    next();
  });
  app.use(json({ limit: '25mb' }));
  app.use(urlencoded({ extended: true, limit: '25mb' }));
  // 请求体解析失败（非法 JSON/超限）发生在进入路由之前，不经过 Nest 的异常过滤器，
  // 会落回 express 默认错误体（{statusCode,message,error}）——/v1 客户端取不到 error.message。
  // 这里补一层：/v1 按客户端协议回错误体，其余路径继续交给 Nest（保持原状）。
  app.use((err: unknown, req: Request, res: Response, next: NextFunction) => {
    if (!err) return next();
    const path = (req.originalUrl ?? req.url ?? '').split('?')[0];
    if (!path.startsWith('/v1')) return next(err);
    if (res.headersSent) return next(err);
    const e = err as { status?: number; statusCode?: number; message?: string };
    const status = e.status ?? e.statusCode ?? 400;
    const message = e.message || 'Invalid request body';
    const type = openaiTypeFor(status);
    res
      .status(status)
      .json(
        path.startsWith('/v1/messages')
          ? toAnthropicErrorBody(message, type)
          : openaiError(message, type),
      );
  });

  // 控制台 API 走 /api 前缀；OpenAI 兼容网关走 /v1；Anthropic 兼容网关走 /v1/messages
  app.setGlobalPrefix('api', {
    exclude: [
      { path: 'v1/chat/completions', method: RequestMethod.POST },
      { path: 'v1/models', method: RequestMethod.GET },
      { path: 'v1/messages', method: RequestMethod.POST },
      { path: 'v1/embeddings', method: RequestMethod.POST },
      { path: 'v1/images/generations', method: RequestMethod.POST },
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

  // 反向代理链：host nginx → web nginx → api（ops/nginx/xiaopuyun.com.conf + apps/web/nginx.conf）。
  // 不声明信任就无法从 X-Forwarded-For 还原真实客户端 IP（req.ip 恒为上一跳容器 IP），
  // 按 IP 的登录限流、审计定位会全部失效。默认信任 docker 网段而非跳数：
  // 经 nginx 的域名流量能正确还原客户端 IP，而直连 3000 端口伪造的 XFF 因来源不在网段内不被采信。
  const trustProxy = parseTrustProxy(
    config.get<string>('TRUST_PROXY', isProd ? '172.16.0.0/12' : 'false'),
  );
  app.getHttpAdapter().getInstance().set('trust proxy', trustProxy);
  Logger.log(`trust proxy = ${JSON.stringify(trustProxy)}`, 'Bootstrap');

  app.useGlobalPipes(
    new ValidationPipe({
      whitelist: true,
      transform: true,
      forbidNonWhitelisted: false,
    }),
  );

  await app.get(BootstrapService).ensureAdmin();

  // Swagger 文档（/api/docs，自带 Try it out 交互式调用）
  // 生产默认关闭（避免暴露全量 API 结构），需要时设 SWAGGER_ENABLED=true 显式开启
  const swaggerFlag = config.get<string>('SWAGGER_ENABLED', '').trim();
  if (swaggerFlag === 'true' || (swaggerFlag !== 'false' && !isProd)) {
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
  } else {
    Logger.log('Swagger 已禁用（生产默认关闭，SWAGGER_ENABLED=true 可开启）', 'Bootstrap');
  }

  // Prometheus 指标（/api/metrics）：生产需设置 METRICS_TOKEN 才开启，防内部指标暴露公网
  const metricsToken = (config.get<string>('METRICS_TOKEN', '') ?? '').trim();
  Logger.log(
    metricsToken
      ? 'Prometheus 指标：/api/metrics（需 METRICS_TOKEN 鉴权）'
      : isProd
        ? 'Prometheus 指标：已禁用（生产设置 METRICS_TOKEN 后开启）'
        : 'Prometheus 指标：/api/metrics（开发环境开放）',
    'Bootstrap',
  );

  app.enableShutdownHooks();

  const port = config.get<number>('PORT', 3000);
  await app.listen(port);
  Logger.log(`API listening on http://localhost:${port}/api`, 'Bootstrap');
  Logger.log(`Gateway listening on http://localhost:${port}/v1`, 'Bootstrap');
}

bootstrap();
