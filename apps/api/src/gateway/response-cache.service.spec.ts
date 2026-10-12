import { ConfigService } from '@nestjs/config';
import {
  ResponseCacheService,
  canonicalize,
  refusalInJson,
  refusalInStreamChunks,
} from './response-cache.service';
import type { RedisService } from '../redis/redis.service';
import type { CachedChatRecord } from './response-cache.service';

describe('ResponseCacheService', () => {
  function makeService(overrides: Record<string, string> = {}) {
    const store = new Map<string, string>();
    const config = { get: (k: string, d?: string) => overrides[k] ?? d };
    const redis = {
      client: {
        get: jest.fn(async (k: string) => store.get(k) ?? null),
        setex: jest.fn(async (k: string, _ttl: number, v: string) => {
          store.set(k, v);
          return 'OK';
        }),
      },
    };
    const svc = new ResponseCacheService(
      config as unknown as ConfigService,
      redis as unknown as RedisService,
    );
    return { svc, redis, store };
  }

  const record: CachedChatRecord = {
    v: 1,
    channelId: 'ch1',
    usage: { promptTokens: 3, completionTokens: 4, totalTokens: 7 },
    json: { id: 'cmpl-1', choices: [] },
  };

  describe('配置解析（越界值回退默认）', () => {
    it('默认：开启 / 折扣 0.6 / TTL 600s / 上限 512KB', () => {
      const { svc } = makeService();
      expect(svc.enabled).toBe(true);
      expect(svc.discount).toBe(0.6);
      expect(svc.ttlMs).toBe(600_000);
      expect(svc.maxBytes).toBe(524_288);
    });

    it('折扣 0/1/负数/非数 回退 0.6；合法值生效', () => {
      expect(makeService({ RESPONSE_CACHE_DISCOUNT: '0' }).svc.discount).toBe(0.6);
      expect(makeService({ RESPONSE_CACHE_DISCOUNT: '1' }).svc.discount).toBe(0.6);
      expect(makeService({ RESPONSE_CACHE_DISCOUNT: '-1' }).svc.discount).toBe(0.6);
      expect(makeService({ RESPONSE_CACHE_DISCOUNT: 'x' }).svc.discount).toBe(0.6);
      expect(makeService({ RESPONSE_CACHE_DISCOUNT: '0.5' }).svc.discount).toBe(0.5);
    });

    it('TTL 过小回退默认、过大截断 1h；开关可关', () => {
      expect(makeService({ RESPONSE_CACHE_TTL_MS: '10' }).svc.ttlMs).toBe(600_000);
      expect(makeService({ RESPONSE_CACHE_TTL_MS: '999999999' }).svc.ttlMs).toBe(3_600_000);
      expect(makeService({ RESPONSE_CACHE_ENABLED: 'false' }).svc.enabled).toBe(false);
    });
  });

  describe('shouldHandle（读写同一口径）', () => {
    it('temperature===0 自动处理；非 0 不处理', () => {
      const { svc } = makeService();
      expect(svc.shouldHandle({ temperature: 0 })).toBe(true);
      expect(svc.shouldHandle({ temperature: 1 })).toBe(false);
      expect(svc.shouldHandle({})).toBe(false); // 缺省 temperature（上游默认 1）不处理
    });

    it('cache:true 强制处理（任意采样参数）；cache:false 强制绕过（即使 temp=0）', () => {
      const { svc } = makeService();
      expect(svc.shouldHandle({ cache: true, temperature: 1 })).toBe(true);
      expect(svc.shouldHandle({ cache: false, temperature: 0 })).toBe(false);
    });

    it('全局关闭 / 无 redis 时不处理', () => {
      expect(
        makeService({ RESPONSE_CACHE_ENABLED: 'false' }).svc.shouldHandle({ cache: true }),
      ).toBe(false);
      const noRedis = new ResponseCacheService({
        get: (_k: string, d?: string) => d,
      } as unknown as ConfigService);
      expect(noRedis.shouldHandle({ cache: true })).toBe(false);
    });
  });

  describe('key（规范化哈希）', () => {
    const base = (svc: ResponseCacheService) =>
      svc.key('m1', { messages: [{ role: 'user', content: 'hi' }], temperature: 0 }, false, [
        'a',
        'b',
      ]);

    it('字段顺序无关；内容变化敏感', () => {
      const { svc } = makeService();
      const k1 = svc.key(
        'm1',
        { temperature: 0, messages: [{ content: 'hi', role: 'user' }] },
        false,
        ['a', 'b'],
      );
      expect(k1).toBe(base(svc));
      expect(
        svc.key('m1', { messages: [{ role: 'user', content: 'ho' }], temperature: 0 }, false, [
          'a',
          'b',
        ]),
      ).not.toBe(k1);
    });

    it('body.model 归一到规范名：别名与规范名命中同一份缓存', () => {
      const { svc } = makeService();
      expect(
        svc.key(
          'm1',
          { model: 'm1:latest', messages: [{ role: 'user', content: 'hi' }], temperature: 0 },
          false,
          ['a', 'b'],
        ),
      ).toBe(base(svc));
    });

    it('流式/非流式、候选渠道集合、温度分别进键', () => {
      const { svc } = makeService();
      const msgs = [{ role: 'user', content: 'hi' }];
      expect(svc.key('m1', { messages: msgs, temperature: 0 }, true, ['a', 'b'])).not.toBe(
        base(svc),
      );
      // 候选集合与顺序无关，但集合不同必须不同键（分组/BYOK 可见性隔离的根基）
      expect(svc.key('m1', { messages: msgs, temperature: 0 }, false, ['b', 'a'])).toBe(base(svc));
      expect(svc.key('m1', { messages: msgs, temperature: 0 }, false, ['a'])).not.toBe(base(svc));
      expect(svc.key('m1', { messages: msgs, temperature: 0.5 }, false, ['a', 'b'])).not.toBe(
        base(svc),
      );
    });

    it('canonicalize：对象键排序、数组保序', () => {
      expect(canonicalize({ b: 1, a: [{ y: 2, x: 1 }] })).toEqual({ a: [{ x: 1, y: 2 }], b: 1 });
    });
  });

  describe('get/set', () => {
    it('写读往返', async () => {
      const { svc, store } = makeService();
      await svc.set('k1', record);
      expect(store.size).toBe(1);
      await expect(svc.get('k1')).resolves.toEqual(record);
    });

    it('miss 与非法记录都返回 null', async () => {
      const { svc, store } = makeService();
      store.set('bad:json', '{oops');
      store.set('bad:shape', JSON.stringify({ v: 2, channelId: 'x' }));
      await expect(svc.get('none')).resolves.toBeNull();
      await expect(svc.get('bad:json')).resolves.toBeNull();
      await expect(svc.get('bad:shape')).resolves.toBeNull();
    });

    it('超过 maxBytes 不写入（Redis 不被调用）', async () => {
      const { svc, redis, store } = makeService({ RESPONSE_CACHE_MAX_BYTES: '1024' });
      await svc.set('big', { ...record, json: { blob: 'x'.repeat(2000) } });
      expect(redis.client.setex).not.toHaveBeenCalled();
      expect(store.size).toBe(0);
    });

    it('写入的 TTL 使用配置值（秒）', async () => {
      const { svc, redis } = makeService({ RESPONSE_CACHE_TTL_MS: '120000' });
      await svc.set('k1', record);
      expect(redis.client.setex).toHaveBeenCalledWith('k1', 120, expect.any(String));
    });

    it('Redis 故障 fail-open：get 返回 null 且进入冷却（后续不再打 Redis）', async () => {
      const { svc, redis } = makeService();
      redis.client.get.mockRejectedValueOnce(new Error('down'));
      await expect(svc.get('k1')).resolves.toBeNull();
      expect(redis.client.get).toHaveBeenCalledTimes(1);
      // 冷却期内读写都跳过（热路径不等重连）
      await expect(svc.get('k1')).resolves.toBeNull();
      await svc.set('k2', record);
      expect(redis.client.get).toHaveBeenCalledTimes(1);
      expect(redis.client.setex).not.toHaveBeenCalled();
    });

    it('set 故障同样 fail-open 不抛出', async () => {
      const { svc, redis } = makeService();
      redis.client.setex.mockRejectedValueOnce(new Error('down'));
      await expect(svc.set('k1', record)).resolves.toBeUndefined();
    });
  });

  describe('拒答判定（拒答不缓存）', () => {
    it('非流式：content_filter / refusal 命中', () => {
      expect(refusalInJson({ choices: [{ finish_reason: 'content_filter' }] })).toBe(true);
      expect(refusalInJson({ choices: [{ message: { refusal: 'no' } }] })).toBe(true);
      expect(
        refusalInJson({ choices: [{ finish_reason: 'stop', message: { content: 'ok' } }] }),
      ).toBe(false);
      expect(refusalInJson({})).toBe(false);
    });

    it('流式：原始分片子串保守匹配', () => {
      expect(
        refusalInStreamChunks(['data: {"choices":[{"finish_reason":"content_filter"}]}\n\n']),
      ).toBe(true);
      expect(refusalInStreamChunks(['data: {"choices":[{"delta":{"content":"hi"}}]}\n\n'])).toBe(
        false,
      );
    });
  });
});
