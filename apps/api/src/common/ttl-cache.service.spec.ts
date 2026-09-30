import { TtlCacheService } from './ttl-cache.service';

describe('TtlCacheService', () => {
  let cache: TtlCacheService;
  beforeEach(() => {
    cache = new TtlCacheService();
  });

  it('命中时不执行 loader', async () => {
    const loader = jest.fn().mockResolvedValue('v');
    await expect(cache.getOrLoad('k', 60_000, loader)).resolves.toBe('v');
    await expect(cache.getOrLoad('k', 60_000, loader)).resolves.toBe('v');
    expect(loader).toHaveBeenCalledTimes(1);
  });

  it('过期后重新加载', async () => {
    const loader = jest.fn().mockResolvedValueOnce('a').mockResolvedValueOnce('b');
    expect(await cache.getOrLoad('k', 15, loader)).toBe('a');
    await new Promise((r) => setTimeout(r, 25));
    expect(await cache.getOrLoad('k', 15, loader)).toBe('b');
    expect(loader).toHaveBeenCalledTimes(2);
  });

  it('并发同 key 只加载一次（防击穿）', async () => {
    const loader = jest.fn(
      () => new Promise<string>((r) => setTimeout(() => r('v'), 10)),
    );
    const results = await Promise.all([
      cache.getOrLoad('k', 60_000, loader),
      cache.getOrLoad('k', 60_000, loader),
      cache.getOrLoad('k', 60_000, loader),
    ]);
    expect(results).toEqual(['v', 'v', 'v']);
    expect(loader).toHaveBeenCalledTimes(1);
  });

  it('loader 失败不缓存且错误透传', async () => {
    const loader = jest
      .fn()
      .mockRejectedValueOnce(new Error('boom'))
      .mockResolvedValueOnce('ok');
    await expect(cache.getOrLoad('k', 60_000, loader)).rejects.toThrow('boom');
    await expect(cache.getOrLoad('k', 60_000, loader)).resolves.toBe('ok');
    expect(loader).toHaveBeenCalledTimes(2);
  });

  it('支持 null 值缓存（与未命中区分）', async () => {
    const loader = jest.fn().mockResolvedValue(null);
    await expect(cache.getOrLoad('k', 60_000, loader)).resolves.toBeNull();
    await expect(cache.getOrLoad('k', 60_000, loader)).resolves.toBeNull();
    expect(loader).toHaveBeenCalledTimes(1);
  });

  it('按前缀失效，不影响其它命名空间', async () => {
    await cache.getOrLoad('cat:all', 60_000, async () => 1);
    await cache.getOrLoad('grp:rows', 60_000, async () => 2);
    cache.invalidate('cat:');
    expect(cache.get('cat:all')).toBeUndefined();
    expect(cache.get('grp:rows')).toBe(2);
  });

  it('无前缀时清空全部', async () => {
    await cache.getOrLoad('a', 60_000, async () => 1);
    cache.invalidate();
    expect(cache.size()).toBe(0);
  });

  it('ttl <= 0 时不缓存', async () => {
    const loader = jest.fn().mockResolvedValue('v');
    await cache.getOrLoad('k', 0, loader);
    await cache.getOrLoad('k', 0, loader);
    expect(loader).toHaveBeenCalledTimes(2);
  });
});
