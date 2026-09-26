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
      k === 'CHANNEL_FAILURE_THRESHOLD' ? String(threshold) : k === 'ALERT_WEBHOOK_URL' ? webhook : d,
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
    prisma.channel.update.mockResolvedValue({ id: 'c1', failureCount: 2, status: ChannelStatus.ENABLED });
    await service.recordFailure('c1', 'boom');
    // 第二次 update（禁用）不应发生
    expect(prisma.channel.update).toHaveBeenCalledTimes(1);
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
    expect(prisma.channel.update).toHaveBeenCalledTimes(2);
    expect(prisma.channel.update).toHaveBeenLastCalledWith({
      where: { id: 'c1' },
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
});
