import { lookup } from 'dns/promises';
import { assertChannelUrlSafe, upstreamAllowsPrivate } from './url-safety';

jest.mock('dns/promises', () => ({ lookup: jest.fn() }));
const lookupMock = lookup as unknown as jest.Mock;

/**
 * 请求时 SSRF 二次校验（DNS rebinding 防护）：
 * 保存渠道时校验过，但域名可能在保存后被改解析 → 每次出站前复验，结果按
 * scheme://host 缓存 60s（成功/失败都缓存，窗口内热路径零 DNS 开销）。
 */
describe('assertChannelUrlSafe（出站请求前复验）', () => {
  const savedEnv = {
    NODE_ENV: process.env.NODE_ENV,
    ALLOW_PRIVATE_UPSTREAM: process.env.ALLOW_PRIVATE_UPSTREAM,
  };

  beforeEach(() => {
    jest.clearAllMocks();
    // 校验只在 production 生效（非生产默认放行给本地开发/e2e）
    process.env.NODE_ENV = 'production';
    delete process.env.ALLOW_PRIVATE_UPSTREAM;
  });

  afterEach(() => {
    if (savedEnv.NODE_ENV === undefined) delete process.env.NODE_ENV;
    else process.env.NODE_ENV = savedEnv.NODE_ENV;
    if (savedEnv.ALLOW_PRIVATE_UPSTREAM === undefined) delete process.env.ALLOW_PRIVATE_UPSTREAM;
    else process.env.ALLOW_PRIVATE_UPSTREAM = savedEnv.ALLOW_PRIVATE_UPSTREAM;
    jest.restoreAllMocks();
  });

  it('公网域名 → 放行；同主机 60s 内复验命中缓存（仅 1 次 DNS）', async () => {
    lookupMock.mockResolvedValue([{ address: '93.184.216.34', family: 4 }]);

    await expect(
      assertChannelUrlSafe('https://api1.recheck-ok.example/v1'),
    ).resolves.toBeUndefined();
    // 同主机不同路径 → 复用缓存，不再查 DNS
    await expect(
      assertChannelUrlSafe('https://api1.recheck-ok.example/v1/chat/completions'),
    ).resolves.toBeUndefined();

    expect(lookupMock).toHaveBeenCalledTimes(1);
  });

  it('解析到私网 → URL_UNSAFE_RESOLVED_PRIVATE，且失败结果也缓存（不重查 DNS）', async () => {
    lookupMock.mockResolvedValue([{ address: '10.0.0.8', family: 4 }]);
    const act = () => assertChannelUrlSafe('http://rebind.recheck-evil.example/v1');

    await expect(act()).rejects.toMatchObject({ code: 'URL_UNSAFE_RESOLVED_PRIVATE' });
    await expect(act()).rejects.toMatchObject({ code: 'URL_UNSAFE_RESOLVED_PRIVATE' });
    expect(lookupMock).toHaveBeenCalledTimes(1);
  });

  it('DNS 解析失败 → URL_UNSAFE_DNS_FAILED（同样按主机缓存）', async () => {
    lookupMock.mockRejectedValue(new Error('ENOTFOUND'));
    const act = () => assertChannelUrlSafe('https://recheck-nxdomain.example/v1');

    await expect(act()).rejects.toMatchObject({ code: 'URL_UNSAFE_DNS_FAILED' });
    await expect(act()).rejects.toMatchObject({ code: 'URL_UNSAFE_DNS_FAILED' });
    expect(lookupMock).toHaveBeenCalledTimes(1);
  });

  it('私网字面量 IP / 内部主机名 → 无需 DNS 直接拒绝', async () => {
    await expect(assertChannelUrlSafe('http://127.0.0.1:8080/v1')).rejects.toMatchObject({
      code: 'URL_UNSAFE_PRIVATE_ADDRESS',
    });
    await expect(assertChannelUrlSafe('http://localhost/v1')).rejects.toMatchObject({
      code: 'URL_UNSAFE_INTERNAL_HOST',
    });
    expect(lookupMock).not.toHaveBeenCalled();
  });

  it('非 production 且未显式 ALLOW_PRIVATE_UPSTREAM → 放行不查 DNS（开发/e2e 语义）', async () => {
    process.env.NODE_ENV = 'test';
    expect(upstreamAllowsPrivate()).toBe(true);

    await expect(assertChannelUrlSafe('http://127.0.0.1:9999/v1')).resolves.toBeUndefined();
    expect(lookupMock).not.toHaveBeenCalled();
  });

  it('显式 ALLOW_PRIVATE_UPSTREAM=true 时即使 production 也放行', async () => {
    process.env.ALLOW_PRIVATE_UPSTREAM = 'true';

    await expect(assertChannelUrlSafe('http://169.254.169.254/latest')).resolves.toBeUndefined();
    expect(lookupMock).not.toHaveBeenCalled();
  });
});
