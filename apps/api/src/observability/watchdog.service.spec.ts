import type { ConfigService } from '@nestjs/config';
import type { PrismaService } from '../prisma/prisma.service';
import type { RedisService } from '../redis/redis.service';
import { WatchdogService } from './watchdog.service';
import type { MetricsService } from './metrics.service';

function makeConfig(map: Record<string, string> = {}): ConfigService {
  return {
    get: (key: string, def = '') => map[key] ?? def,
  } as unknown as ConfigService;
}

describe('WatchdogService', () => {
  let prisma: { $queryRaw: jest.Mock };
  let redis: { client: { ping: jest.Mock } };
  let metrics: { setServiceUp: jest.Mock; setCertExpiryDays: jest.Mock };
  let fetchMock: jest.Mock;
  let config: ConfigService;

  beforeEach(() => {
    prisma = { $queryRaw: jest.fn().mockResolvedValue([]) };
    redis = { client: { ping: jest.fn().mockResolvedValue('PONG') } };
    metrics = { setServiceUp: jest.fn(), setCertExpiryDays: jest.fn() };
    fetchMock = jest.fn().mockResolvedValue({ ok: true });
    (global as unknown as { fetch: unknown }).fetch = fetchMock;
    config = makeConfig({ ALERT_WEBHOOK_URL: 'https://hooks.test/alerts' });
  });

  afterEach(() => {
    delete (global as unknown as { fetch?: unknown }).fetch;
  });

  function make(): WatchdogService {
    return new WatchdogService(
      prisma as unknown as PrismaService,
      redis as unknown as RedisService,
      metrics as unknown as MetricsService,
      config,
    );
  }

  function alertBody(call: number): Record<string, unknown> {
    return JSON.parse(fetchMock.mock.calls[call][1].body);
  }

  it('首检通过：写 service_up 指标但不告警', async () => {
    const w = make();
    await w.runHealth();
    expect(metrics.setServiceUp).toHaveBeenCalledWith('db', true);
    expect(metrics.setServiceUp).toHaveBeenCalledWith('redis', true);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('依赖故障 → service_degraded 只告警一次，恢复 → service_recovered', async () => {
    const w = make();
    prisma.$queryRaw.mockRejectedValue(new Error('connection refused'));

    await w.runHealth();
    await w.runHealth(); // 持续 down，不重复告警
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(alertBody(0)).toMatchObject({ type: 'service_degraded', down: ['db'] });
    expect(metrics.setServiceUp).toHaveBeenCalledWith('db', false);

    prisma.$queryRaw.mockResolvedValue([]);
    await w.runHealth();
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(alertBody(1).type).toBe('service_recovered');
    expect(metrics.setServiceUp).toHaveBeenCalledWith('db', true);
  });

  it('redis 非 PONG 视为故障', async () => {
    const w = make();
    redis.client.ping.mockResolvedValue('NOPE');
    await w.runHealth();
    expect(alertBody(0)).toMatchObject({ type: 'service_degraded', down: ['redis'] });
  });

  it('证书进入预警期 → cert_expiring 告警，24h 内不重发，续期后复位可再次告警', async () => {
    const w = make();
    const probe = jest
      .spyOn(w as unknown as { probeCert: () => Promise<unknown> }, 'probeCert')
      .mockResolvedValue({ validTo: '2026-10-10T00:00:00.000Z', daysLeft: 5 });

    await w.runCert();
    expect(metrics.setCertExpiryDays).toHaveBeenCalledWith('xiaopuyun.com', 5);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(alertBody(0)).toMatchObject({ type: 'cert_expiring', daysLeft: 5 });

    await w.runCert(); // 24h 内重跑
    expect(fetchMock).toHaveBeenCalledTimes(1);

    probe.mockResolvedValue({ validTo: '2027-06-01T00:00:00.000Z', daysLeft: 200 });
    await w.runCert(); // 续期 → 复位

    probe.mockResolvedValue({ validTo: '2026-10-10T00:00:00.000Z', daysLeft: 4 });
    await w.runCert();
    expect(fetchMock).toHaveBeenCalledTimes(2); // 复位后重新告警
    expect(alertBody(1)).toMatchObject({ type: 'cert_expiring', daysLeft: 4 });
  });

  it('证书探测失败 → 指标记 -1，不告警（临时网络问题）', async () => {
    const w = make();
    jest
      .spyOn(w as unknown as { probeCert: () => Promise<unknown> }, 'probeCert')
      .mockRejectedValue(new Error('TLS 握手超时'));
    await w.runCert();
    expect(metrics.setCertExpiryDays).toHaveBeenCalledWith('xiaopuyun.com', -1);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('未配置 CERT_CHECK_HOST → 跳过证书检查', async () => {
    const w = new WatchdogService(
      prisma as unknown as PrismaService,
      redis as unknown as RedisService,
      metrics as unknown as MetricsService,
      makeConfig({ CERT_CHECK_HOST: '' }),
    );
    await w.runCert();
    expect(metrics.setCertExpiryDays).not.toHaveBeenCalled();
  });

  it('生命周期钩子启停不抛异常', () => {
    const w = make();
    w.onModuleInit();
    w.onModuleDestroy();
    expect(true).toBe(true);
  });
});
