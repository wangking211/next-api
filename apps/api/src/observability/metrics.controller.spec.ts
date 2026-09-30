import { ForbiddenException, UnauthorizedException } from '@nestjs/common';
import type { ConfigService } from '@nestjs/config';
import type { Request, Response } from 'express';
import { MetricsController } from './metrics.controller';
import { MetricsService } from './metrics.service';

function makeConfig(map: Record<string, string>): ConfigService {
  return { get: (key: string, def = '') => map[key] ?? def } as unknown as ConfigService;
}

function fakeReq(headers: Record<string, string> = {}) {
  return {
    header: (name: string) => headers[name.toLowerCase()],
  } as unknown as Request;
}

function fakeRes(): Response {
  return { setHeader: jest.fn() } as unknown as Response;
}

describe('MetricsController', () => {
  it('设置 METRICS_TOKEN：缺失或错误 token → 401', async () => {
    const c = new MetricsController(
      makeConfig({ METRICS_TOKEN: 's3cret' }),
      new MetricsService(),
    );
    await expect(c.scrape(fakeReq(), fakeRes())).rejects.toBeInstanceOf(
      UnauthorizedException,
    );
    await expect(
      c.scrape(fakeReq({ authorization: 'Bearer wrong' }), fakeRes()),
    ).rejects.toBeInstanceOf(UnauthorizedException);
  });

  it('设置 METRICS_TOKEN：Bearer 或 X-Metrics-Token 正确 → 文本格式', async () => {
    const res = fakeRes();
    const c = new MetricsController(
      makeConfig({ METRICS_TOKEN: 's3cret' }),
      new MetricsService(),
    );
    const viaBearer = await c.scrape(
      fakeReq({ authorization: 'Bearer s3cret' }),
      res,
    );
    expect(viaBearer).toContain('http_requests_total');
    expect(res.setHeader).toHaveBeenCalledWith(
      'content-type',
      'text/plain; version=0.0.4; charset=utf-8',
    );

    const viaHeader = await c.scrape(fakeReq({ 'x-metrics-token': 's3cret' }), fakeRes());
    expect(viaHeader).toContain('# HELP');
  });

  it('生产未设置 METRICS_TOKEN → 403（默认关闭）', async () => {
    const c = new MetricsController(
      makeConfig({ NODE_ENV: 'production' }),
      new MetricsService(),
    );
    await expect(c.scrape(fakeReq(), fakeRes())).rejects.toBeInstanceOf(
      ForbiddenException,
    );
  });

  it('非生产未设置 METRICS_TOKEN → 开放', async () => {
    const c = new MetricsController(
      makeConfig({ NODE_ENV: 'development' }),
      new MetricsService(),
    );
    const text = await c.scrape(fakeReq(), fakeRes());
    expect(text).toContain('# HELP');
    expect(text).toContain('process_uptime_seconds');
  });
});
