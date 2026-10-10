import { Logger } from '@nestjs/common';
import { ChannelHealthService } from './channel-health.service';
import { PrismaService } from '../prisma/prisma.service';
import { ConfigService } from '@nestjs/config';
import { ChannelStatus } from '@prisma/client';

function makeService(threshold = 3, webhook?: string) {
  const prisma = {
    channel: {
      updateMany: jest.fn().mockResolvedValue({ count: 1 }),
      update: jest.fn(),
    },
  };
  const config = {
    get: (k: string, d?: string) =>
      k === 'CHANNEL_FAILURE_THRESHOLD'
        ? String(threshold)
        : k === 'ALERT_WEBHOOK_URL'
          ? webhook
          : d,
  } as unknown as ConfigService;
  const service = new ChannelHealthService(prisma as unknown as PrismaService, config);
  return { service, prisma };
}

describe('ChannelHealthService', () => {
  it('resets failure count on success', async () => {
    const { service, prisma } = makeService();
    await service.recordSuccess('c1');
    expect(prisma.channel.updateMany).toHaveBeenCalledWith({
      where: { id: 'c1', failureCount: { gt: 0 } },
      data: { failureCount: 0, lastErrorMsg: null },
    });
  });

  it('does not disable below threshold', async () => {
    const { service, prisma } = makeService(3);
    prisma.channel.update.mockResolvedValue({
      id: 'c1',
      failureCount: 2,
      status: ChannelStatus.ENABLED,
    });
    await service.recordFailure('c1', 'boom');
    // 第二次 update（禁用）不应发生
    expect(prisma.channel.update).toHaveBeenCalledTimes(1);
  });

  it('count:false 只记失败现场，不累计计数也不触发禁用（模型级故障豁免）', async () => {
    const { service, prisma } = makeService(3);
    // 假设行上已有 5 次失败（≥阈值）——不计数时既不该递增也不该禁用
    prisma.channel.update.mockResolvedValue({
      id: 'c1',
      failureCount: 5,
      status: ChannelStatus.ENABLED,
    });
    await service.recordFailure('c1', 'model-scoped boom', { count: false });
    expect(prisma.channel.update).toHaveBeenCalledTimes(1);
    expect(prisma.channel.update).toHaveBeenCalledWith({
      where: { id: 'c1' },
      data: expect.not.objectContaining({ failureCount: expect.anything() }),
    });
    expect(prisma.channel.update).toHaveBeenCalledWith({
      where: { id: 'c1' },
      data: expect.objectContaining({
        lastErrorAt: expect.any(Date),
        lastErrorMsg: 'model-scoped boom',
      }),
    });
  });

  it('auto-disables at threshold', async () => {
    const { service, prisma } = makeService(3);
    prisma.channel.update.mockResolvedValueOnce({
      id: 'c1',
      name: 'bad',
      provider: 'openai',
      ownerType: 'USER',
      failureCount: 3,
      status: ChannelStatus.ENABLED,
    });
    await service.recordFailure('c1', 'boom');
    expect(prisma.channel.update).toHaveBeenCalledTimes(1);
    expect(prisma.channel.updateMany).toHaveBeenCalledWith({
      where: { id: 'c1', status: ChannelStatus.ENABLED },
      data: { status: ChannelStatus.DISABLED, autoDisabled: true },
    });
  });

  it('does not re-disable an already disabled channel', async () => {
    const { service, prisma } = makeService(3);
    prisma.channel.update.mockResolvedValueOnce({
      id: 'c1',
      failureCount: 9,
      status: ChannelStatus.DISABLED,
    });
    await service.recordFailure('c1', 'boom');
    expect(prisma.channel.update).toHaveBeenCalledTimes(1);
  });

  it('rate limited only records the error scene, never increments failure count', async () => {
    const { service, prisma } = makeService(3);
    await service.recordRateLimited('c1', 'upstream 429: rate limit exceeded');
    // 不做 update（不 increment failureCount）→ 不可能触发自动禁用
    expect(prisma.channel.update).not.toHaveBeenCalled();
    expect(prisma.channel.updateMany).toHaveBeenCalledTimes(1);
    expect(prisma.channel.updateMany).toHaveBeenCalledWith({
      where: { id: 'c1' },
      data: { lastErrorAt: expect.any(Date), lastErrorMsg: 'upstream 429: rate limit exceeded' },
    });
  });

  it('sends webhook alert when configured', async () => {
    const fetchSpy = jest.spyOn(global, 'fetch').mockResolvedValue({} as any);
    const { service, prisma } = makeService(2, 'https://alert.example/hook');
    prisma.channel.update.mockResolvedValueOnce({
      id: 'c1',
      name: 'bad',
      provider: 'openai',
      ownerType: 'USER',
      failureCount: 2,
      status: ChannelStatus.ENABLED,
    });
    await service.recordFailure('c1', 'boom');
    expect(fetchSpy).toHaveBeenCalledWith(
      'https://alert.example/hook',
      expect.objectContaining({ method: 'POST' }),
    );
    fetchSpy.mockRestore();
  });

  describe('静默 catch 可观测性（写库失败必须留痕，且不抛出）', () => {
    let warnSpy: jest.SpyInstance;
    let errorSpy: jest.SpyInstance;

    beforeEach(() => {
      warnSpy = jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
      errorSpy = jest.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);
    });

    afterEach(() => {
      warnSpy.mockRestore();
      errorSpy.mockRestore();
    });

    const loggedCalls = () =>
      [...warnSpy.mock.calls, ...errorSpy.mock.calls].map((c) => String(c[0]));

    it('recordSuccess: 清零写库失败时记录 warn（含 channelId 与错误信息）且不抛出', async () => {
      const { service, prisma } = makeService();
      prisma.channel.updateMany.mockRejectedValueOnce(new Error('db down'));

      await expect(service.recordSuccess('c1')).resolves.toBeUndefined();

      const logged = loggedCalls();
      expect(logged.some((m) => m.includes('c1') && m.includes('db down'))).toBe(true);
    });

    it('recordFailure: 失败计数写库失败时记录 warn/error（含 channelId 与错误信息）且不抛出', async () => {
      const { service, prisma } = makeService();
      prisma.channel.update.mockRejectedValueOnce(new Error('connection refused'));

      await expect(service.recordFailure('c1', 'boom')).resolves.toBeUndefined();

      const logged = loggedCalls();
      expect(logged.some((m) => m.includes('c1') && m.includes('connection refused'))).toBe(true);
    });

    it('recordFailure: 自动禁用写库失败时同样留痕且不抛出', async () => {
      const { service, prisma } = makeService(3);
      prisma.channel.update.mockResolvedValueOnce({
        id: 'c1',
        name: 'bad',
        provider: 'openai',
        ownerType: 'USER',
        failureCount: 3,
        status: ChannelStatus.ENABLED,
      });
      prisma.channel.updateMany.mockRejectedValueOnce(new Error('deadlock detected'));

      await expect(service.recordFailure('c1', 'boom')).resolves.toBeUndefined();

      const logged = loggedCalls();
      expect(logged.some((m) => m.includes('c1') && m.includes('deadlock detected'))).toBe(true);
    });

    it('recordRateLimited: 限流现场写库失败时记录 warn（含 channelId 与错误信息）且不抛出', async () => {
      const { service, prisma } = makeService();
      prisma.channel.updateMany.mockRejectedValueOnce(new Error('redis gone'));

      await expect(service.recordRateLimited('c1', 'upstream 429')).resolves.toBeUndefined();

      const logged = loggedCalls();
      expect(logged.some((m) => m.includes('c1') && m.includes('redis gone'))).toBe(true);
    });
  });
});
