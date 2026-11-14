import { Readable } from 'node:stream';
import { ConfigService } from '@nestjs/config';
import { AssetCaptureService } from './asset-capture.service';
import { PrismaService } from '../prisma/prisma.service';
import { CryptoService } from '../common/crypto.service';
import { ProviderRegistry } from '../gateway/providers/provider.registry';
import { CosStorageService } from './cos-storage.service';

function makeService() {
  const prisma = {
    mediaAsset: {
      upsert: jest.fn().mockResolvedValue({ id: 'a1' }),
      create: jest.fn().mockResolvedValue({ id: 'img1' }),
      findUnique: jest.fn().mockResolvedValue(null),
      findMany: jest.fn().mockResolvedValue([]),
      update: jest.fn().mockResolvedValue({}),
      updateMany: jest.fn().mockResolvedValue({ count: 1 }),
    },
    channel: { findUnique: jest.fn().mockResolvedValue(null) },
  };
  const cos = {
    enabled: true,
    prefix: 'aigw-assets/',
    objectKey: jest.fn().mockReturnValue('aigw-assets/u/2026/11/a1.mp4'),
    putObject: jest.fn().mockResolvedValue(5),
  };
  const providers = { resolve: jest.fn() };
  const crypto = { decrypt: jest.fn().mockReturnValue('upstream-key') };
  const config = { get: (_k: string, d?: string) => d };
  const service = new AssetCaptureService(
    prisma as unknown as PrismaService,
    cos as unknown as CosStorageService,
    providers as unknown as ProviderRegistry,
    crypto as unknown as CryptoService,
    config as unknown as ConfigService,
  );
  return { service, prisma, cos, providers, crypto };
}

const VIDEO_ASSET = {
  id: 'a1',
  userId: 'u1',
  apiKeyId: 'k1',
  channelId: 'c1',
  requestLogId: null,
  kind: 'VIDEO',
  status: 'CAPTURING',
  model: 'seedance-2.0',
  sourceTaskId: 'task_1',
  sourceUrl: null,
  storageKey: null,
  bytes: null,
  contentType: null,
  width: null,
  height: null,
  durationSeconds: null,
  meta: null,
  error: null,
  createdAt: new Date(),
  updatedAt: new Date(),
  readyAt: null,
};

const CHANNEL = {
  id: 'c1',
  provider: 'openai',
  baseUrl: 'https://up/v1',
  apiKeyEnc: 'enc',
};

describe('AssetCaptureService', () => {
  it('registerVideo：按上游任务幂等 upsert，已存在不覆盖', async () => {
    const { service, prisma } = makeService();

    const id = await service.registerVideo({
      userId: 'u1',
      apiKeyId: 'k1',
      channelId: 'c1',
      model: 'seedance-2.0',
      taskId: 'task_1',
      meta: { seconds: 4 },
    });

    expect(id).toBe('a1');
    const args = prisma.mediaAsset.upsert.mock.calls[0][0];
    expect(args.where).toEqual({ sourceTaskId: 'task_1' });
    expect(args.create).toMatchObject({
      kind: 'VIDEO',
      model: 'seedance-2.0',
      sourceTaskId: 'task_1',
    });
    expect(args.update).toEqual({});
  });

  it('registerVideo：空 taskId 不写库', async () => {
    const { service, prisma } = makeService();

    expect(
      await service.registerVideo({
        userId: 'u1',
        apiKeyId: 'k1',
        channelId: 'c1',
        model: 'm',
        taskId: '',
      }),
    ).toBeNull();
    expect(prisma.mediaAsset.upsert).not.toHaveBeenCalled();
  });

  it('attachLog 只在尚未回填时写', async () => {
    const { service, prisma } = makeService();

    await service.attachLog('a1', 'log1');

    expect(prisma.mediaAsset.updateMany).toHaveBeenCalledWith({
      where: { id: 'a1', requestLogId: null },
      data: { requestLogId: 'log1' },
    });
  });

  it('captureVideoTask：非属主/已就绪一律不触发抓取', async () => {
    const { service, prisma } = makeService();
    const spy = jest.spyOn(service, 'captureAsset');

    prisma.mediaAsset.findUnique.mockResolvedValue({
      id: 'a1',
      userId: 'other',
      status: 'PENDING',
    });
    await service.captureVideoTask('task_1', 'u1');

    prisma.mediaAsset.findUnique.mockResolvedValue({ id: 'a1', userId: 'u1', status: 'READY' });
    await service.captureVideoTask('task_1', 'u1');

    expect(spy).not.toHaveBeenCalled();
  });

  it('captureVideoTask：属主且未就绪 → 触发抓取', async () => {
    const { service, prisma } = makeService();
    const spy = jest.spyOn(service, 'captureAsset').mockResolvedValue(undefined);
    prisma.mediaAsset.findUnique.mockResolvedValue({ id: 'a1', userId: 'u1', status: 'PENDING' });

    await service.captureVideoTask('task_1', 'u1');

    expect(spy).toHaveBeenCalledWith('a1');
  });

  it('captureAsset：抢占成功后拉上游流并写 READY', async () => {
    const { service, prisma, cos, providers } = makeService();
    prisma.mediaAsset.findUnique.mockResolvedValue(VIDEO_ASSET);
    prisma.channel.findUnique.mockResolvedValue(CHANNEL);
    providers.resolve.mockReturnValue({
      videoContent: jest.fn().mockResolvedValue({
        status: 200,
        contentType: 'video/mp4',
        contentLength: '5',
        stream: Readable.toWeb(Readable.from([Buffer.from('hello')])),
      }),
    });

    await service.captureAsset('a1');

    expect(cos.putObject).toHaveBeenCalledWith(
      'aigw-assets/u/2026/11/a1.mp4',
      expect.anything(),
      'video/mp4',
      5,
    );
    expect(prisma.mediaAsset.update).toHaveBeenCalledWith({
      where: { id: 'a1' },
      data: expect.objectContaining({
        status: 'READY',
        storageKey: 'aigw-assets/u/2026/11/a1.mp4',
        bytes: 5,
      }),
    });
  });

  it('captureAsset：已被别的流程抢占（count=0）→ 直接返回', async () => {
    const { service, prisma, cos } = makeService();
    prisma.mediaAsset.updateMany.mockResolvedValue({ count: 0 });

    await service.captureAsset('a1');

    expect(cos.putObject).not.toHaveBeenCalled();
    expect(prisma.mediaAsset.findUnique).not.toHaveBeenCalled();
  });

  it('captureAsset：渠道已删除 → 标记 FAILED 并给出原因', async () => {
    const { service, prisma } = makeService();
    prisma.mediaAsset.findUnique.mockResolvedValue(VIDEO_ASSET);
    prisma.channel.findUnique.mockResolvedValue(null);

    await service.captureAsset('a1');

    expect(prisma.mediaAsset.updateMany).toHaveBeenLastCalledWith({
      where: { id: 'a1', status: { not: 'READY' } },
      data: { status: 'FAILED', error: expect.stringContaining('渠道已删除') },
    });
  });

  it('captureImages：b64 图片识别为 png 后上传', async () => {
    const { service, prisma, cos } = makeService();
    prisma.mediaAsset.findUnique.mockResolvedValue({
      ...VIDEO_ASSET,
      id: 'img1',
      kind: 'IMAGE',
      sourceTaskId: null,
      sourceUrl: null,
    });
    const png = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

    await service.captureImages({
      userId: 'u1',
      apiKeyId: 'k1',
      channelId: 'c1',
      model: 'gpt-image-1',
      response: { data: [{ b64_json: png.toString('base64') }] },
    });
    // captureImageRow 是后台 Promise，等一轮事件循环
    await new Promise((r) => setImmediate(r));
    await new Promise((r) => setImmediate(r));

    expect(cos.putObject).toHaveBeenCalledWith(
      expect.any(String),
      expect.any(Buffer),
      'image/png',
      undefined,
    );
  });

  it('captureImages：响应无 url/b64 时不建行', async () => {
    const { service, prisma } = makeService();

    await service.captureImages({
      userId: 'u1',
      apiKeyId: 'k1',
      channelId: 'c1',
      model: 'm',
      response: { data: [{ revised_prompt: 'x' }] },
    });

    expect(prisma.mediaAsset.create).not.toHaveBeenCalled();
  });
});
