import { BadRequestException, NotFoundException } from '@nestjs/common';
import { AssetsService } from './assets.service';
import { PrismaService } from '../prisma/prisma.service';
import { CosStorageService } from './cos-storage.service';
import { AssetCaptureService } from './asset-capture.service';

function makeService() {
  const prisma = {
    mediaAsset: {
      findMany: jest.fn().mockResolvedValue([]),
      findFirst: jest.fn().mockResolvedValue(null),
      count: jest.fn().mockResolvedValue(0),
      update: jest.fn().mockResolvedValue({}),
      delete: jest.fn().mockResolvedValue({}),
      deleteMany: jest.fn().mockResolvedValue({ count: 0 }),
    },
  };
  const cos = {
    enabled: true,
    prefix: 'aigw-assets/',
    presignTtlSec: 3600,
    signedUrl: jest.fn().mockReturnValue('https://cos.example/asset'),
    remove: jest.fn().mockResolvedValue(undefined),
    purgePrefix: jest.fn().mockResolvedValue(3),
  };
  const capture = { captureAsset: jest.fn() };
  const service = new AssetsService(
    prisma as unknown as PrismaService,
    cos as unknown as CosStorageService,
    capture as unknown as AssetCaptureService,
  );
  return { service, prisma, cos, capture };
}

const READY_ROW = {
  id: 'a1',
  kind: 'VIDEO',
  status: 'READY',
  model: 'seedance-2.0',
  sourceTaskId: 'task_1',
  sourceUrl: null,
  storageKey: 'aigw-assets/u/2026/11/a1.mp4',
  bytes: 1442316,
  contentType: 'video/mp4',
  width: null,
  height: null,
  durationSeconds: 4,
  meta: null,
  error: null,
  createdAt: new Date(),
  readyAt: new Date(),
  user: { id: 'u1', username: 'alice' },
  channel: { id: 'c1', name: 'ch', provider: 'openai' },
};

describe('AssetsService', () => {
  it('普通用户列表强制按本人过滤', async () => {
    const { service, prisma } = makeService();

    await service.list('u1', { page: 1, pageSize: 24 });

    expect(prisma.mediaAsset.findMany.mock.calls[0][0].where.userId).toBe('u1');
    expect(prisma.mediaAsset.count.mock.calls[0][0].where.userId).toBe('u1');
  });

  it('管理员（null）默认全量，可按 userId 收窄', async () => {
    const { service, prisma } = makeService();

    await service.list(null, {});
    expect(prisma.mediaAsset.findMany.mock.calls[0][0].where.userId).toBeUndefined();

    await service.list(null, { userId: 'u2' });
    expect(prisma.mediaAsset.findMany.mock.calls[1][0].where.userId).toBe('u2');
  });

  it('pageSize 上限 100，非法值回退默认', async () => {
    const { service, prisma } = makeService();

    await service.list('u1', { pageSize: 9999 });
    expect(prisma.mediaAsset.findMany.mock.calls[0][0].take).toBe(100);

    await service.list('u1', {});
    expect(prisma.mediaAsset.findMany.mock.calls[1][0].take).toBe(24);
  });

  it('列表只对 READY 且已有对象的行签发下载地址', async () => {
    const { service, prisma, cos } = makeService();
    prisma.mediaAsset.findMany.mockResolvedValue([
      READY_ROW,
      { ...READY_ROW, id: 'a2', status: 'PENDING', storageKey: null },
    ]);

    const out = await service.list('u1', {});

    expect(out.items[0].url).toBe('https://cos.example/asset');
    expect(out.items[1].url).toBeNull();
    expect(cos.signedUrl).toHaveBeenCalledTimes(1);
  });

  it('downloadUrl：未就绪 → ASSET_NOT_READY', async () => {
    const { service, prisma } = makeService();
    prisma.mediaAsset.findFirst.mockResolvedValue({
      id: 'a1',
      status: 'PENDING',
      storageKey: null,
    });

    await expect(service.downloadUrl('u1', 'a1')).rejects.toBeInstanceOf(BadRequestException);
  });

  it('downloadUrl：不存在 → NotFound', async () => {
    const { service } = makeService();
    await expect(service.downloadUrl('u1', 'a1')).rejects.toBeInstanceOf(NotFoundException);
  });

  it('contentMeta 返回下载文件名与类型（网关代理下载用）', async () => {
    const { service, prisma } = makeService();
    prisma.mediaAsset.findFirst.mockResolvedValue({
      id: 'a1',
      status: 'READY',
      storageKey: 'k',
      contentType: 'video/mp4',
      bytes: 100,
    });

    const meta = await service.contentMeta('u1', 'a1');

    expect(meta).toMatchObject({
      url: 'https://cos.example/asset',
      contentType: 'video/mp4',
      filename: 'asset-a1.mp4',
    });
  });

  it('删除先删对象再删行', async () => {
    const { service, prisma, cos } = makeService();
    prisma.mediaAsset.findFirst.mockResolvedValue({ id: 'a1', storageKey: 'k' });

    await service.remove('u1', 'a1');

    expect(cos.remove).toHaveBeenCalledWith('k');
    expect(prisma.mediaAsset.delete).toHaveBeenCalledWith({ where: { id: 'a1' } });
  });

  it('retry：已就绪不再重复抓取', async () => {
    const { service, prisma, capture } = makeService();
    prisma.mediaAsset.findFirst.mockResolvedValue({ id: 'a1', status: 'READY' });

    const out = await service.retry('u1', 'a1');

    expect(out).toEqual({ id: 'a1', status: 'READY' });
    expect(capture.captureAsset).not.toHaveBeenCalled();
  });

  it('retry：失败/等待中 → 重置为 PENDING 并触发抓取', async () => {
    const { service, prisma, capture } = makeService();
    prisma.mediaAsset.findFirst.mockResolvedValue({ id: 'a1', status: 'FAILED' });

    await service.retry('u1', 'a1');

    expect(prisma.mediaAsset.update).toHaveBeenCalledWith({
      where: { id: 'a1' },
      data: { status: 'PENDING', error: null },
    });
    expect(capture.captureAsset).toHaveBeenCalledWith('a1');
  });

  it('一键清理：删除前缀对象并清空记录', async () => {
    const { service, prisma, cos } = makeService();
    prisma.mediaAsset.deleteMany.mockResolvedValue({ count: 2 });

    const out = await service.purgeAll();

    expect(cos.purgePrefix).toHaveBeenCalled();
    expect(prisma.mediaAsset.deleteMany).toHaveBeenCalledWith({});
    expect(out).toEqual({ deletedObjects: 3, deletedRecords: 2, prefix: 'aigw-assets/' });
  });
});
