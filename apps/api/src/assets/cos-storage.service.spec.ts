import { Readable } from 'node:stream';
import { ConfigService } from '@nestjs/config';
import { CosStorageService, extForContentType } from './cos-storage.service';

const mockCos = {
  putObject: jest.fn(),
  getObjectUrl: jest.fn(),
  deleteObject: jest.fn(),
  getBucket: jest.fn(),
  deleteMultipleObject: jest.fn(),
};

jest.mock('cos-nodejs-sdk-v5', () => ({
  __esModule: true,
  default: jest.fn(() => mockCos),
}));

function makeConfig(env: Record<string, string | undefined>): ConfigService {
  return { get: (key: string) => env[key] } as unknown as ConfigService;
}

const FULL_ENV = {
  COS_SECRET_ID: 'id',
  COS_SECRET_KEY: 'key',
  COS_BUCKET: 'bucket-1250000000',
  COS_REGION: 'ap-guangzhou',
  ASSET_COS_PREFIX: 'aigw-assets',
  ASSET_PRESIGN_TTL_SEC: '1800',
};

describe('CosStorageService', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('缺少凭据时禁用，不构造客户端', async () => {
    const svc = new CosStorageService(makeConfig({}));
    expect(svc.enabled).toBe(false);
    expect(svc.signedUrl('k')).toBeNull();
    // putObject 是 async：未配置时返回 rejected promise（同步 throw 会变成未捕获异常）
    await expect(svc.putObject('k', Buffer.from('x'), 'image/png')).rejects.toThrow(
      '对象存储未配置',
    );
  });

  it('前缀自动补 /（默认 aigw-assets/）', () => {
    expect(new CosStorageService(makeConfig(FULL_ENV)).prefix).toBe('aigw-assets/');
    expect(
      new CosStorageService(makeConfig({ ...FULL_ENV, ASSET_COS_PREFIX: '/assets/v2/' })).prefix,
    ).toBe('assets/v2/');
    expect(new CosStorageService(makeConfig({ ...FULL_ENV, ASSET_COS_PREFIX: '   ' })).prefix).toBe(
      'aigw-assets/',
    );
  });

  it('objectKey 带前缀与用户/年月分层，文件扩展名跟 MIME', () => {
    const svc = new CosStorageService(makeConfig(FULL_ENV));
    const key = svc.objectKey('user-1', 'asset-9', extForContentType('video/mp4'));
    expect(key.startsWith('aigw-assets/user-1/')).toBe(true);
    expect(key.endsWith('/asset-9.mp4')).toBe(true);
    expect(extForContentType('image/jpeg')).toBe('jpg');
    expect(extForContentType('application/octet-stream')).toBe('bin');
    expect(extForContentType(null)).toBe('bin');
  });

  it('Buffer 上传使用声明长度并返回字节数', async () => {
    const svc = new CosStorageService(makeConfig(FULL_ENV));
    const buf = Buffer.from('hello');

    const n = await svc.putObject('k1', buf, 'image/png');

    expect(n).toBe(5);
    expect(mockCos.putObject).toHaveBeenCalledWith(
      expect.objectContaining({
        Bucket: 'bucket-1250000000',
        Region: 'ap-guangzhou',
        Key: 'k1',
        Body: buf,
        ContentType: 'image/png',
        ContentLength: 5,
      }),
    );
  });

  it('未知长度的流也能边传边计数', async () => {
    // 模拟 COS 侧消费上传流：只有读完 Transform 的计数才会增长
    mockCos.putObject.mockImplementationOnce(async (params: { Body: AsyncIterable<unknown> }) => {
      for await (const _chunk of params.Body) void _chunk;
      return {};
    });
    const svc = new CosStorageService(makeConfig(FULL_ENV));

    const n = await svc.putObject(
      'k2',
      Readable.from([Buffer.alloc(3), Buffer.alloc(4)]),
      'video/mp4',
    );

    expect(n).toBe(7);
  });

  it('预签名地址带 Sign/Expires，有效期取配置', () => {
    mockCos.getObjectUrl.mockReturnValue('https://signed');
    const svc = new CosStorageService(makeConfig(FULL_ENV));

    expect(svc.signedUrl('k3')).toBe('https://signed');
    expect(svc.presignTtlSec).toBe(1800);
    expect(mockCos.getObjectUrl).toHaveBeenCalledWith({
      Bucket: 'bucket-1250000000',
      Region: 'ap-guangzhou',
      Key: 'k3',
      Sign: true,
      Expires: 1800,
    });
  });

  it('删除失败只记日志，不抛给调用方', async () => {
    mockCos.deleteObject.mockRejectedValue(new Error('NoSuchKey'));
    const svc = new CosStorageService(makeConfig(FULL_ENV));

    await expect(svc.remove('k4')).resolves.toBeUndefined();
  });

  it('purgePrefix 按前缀分批列举并批量删除', async () => {
    mockCos.getBucket
      .mockResolvedValueOnce({
        Contents: [{ Key: 'aigw-assets/u/1.mp4' }, { Key: 'aigw-assets/u/2.mp4' }],
      })
      .mockResolvedValueOnce({ Contents: [] });
    mockCos.deleteMultipleObject.mockResolvedValue({});

    const svc = new CosStorageService(makeConfig(FULL_ENV));
    const n = await svc.purgePrefix();

    expect(n).toBe(2);
    expect(mockCos.getBucket).toHaveBeenCalledWith(
      expect.objectContaining({ Prefix: 'aigw-assets/', MaxKeys: 1000 }),
    );
    expect(mockCos.deleteMultipleObject).toHaveBeenCalledWith({
      Bucket: 'bucket-1250000000',
      Region: 'ap-guangzhou',
      Objects: [{ Key: 'aigw-assets/u/1.mp4' }, { Key: 'aigw-assets/u/2.mp4' }],
    });
  });
});
