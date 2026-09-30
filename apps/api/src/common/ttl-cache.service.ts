import { Injectable } from '@nestjs/common';

interface Entry {
  value: unknown;
  /** 过期时刻（epoch ms） */
  expiresAt: number;
}

/**
 * 进程内 TTL 缓存（轻量，无外部依赖）。
 *
 * 用途：网关热路径上「读多写极少」的参考数据（模型目录全表、分组行等），
 * 通过短 TTL + 显式失效把每请求的重复 SELECT 归零。
 *
 * 语义：
 * - `getOrLoad` 命中直接返回；未命中执行 loader，并对同 key 的并发调用去抖
 *   （in-flight 去重，避免缓存击穿时的并发重复查询）；
 * - loader 抛错不缓存，错误原样抛给调用方；
 * - `invalidate()` 支持前缀匹配，写路径只需失效一个命名空间。
 *
 * 单实例（@Global 模块提供）；多副本部署时各进程各自持有，靠 TTL 收敛。
 */
@Injectable()
export class TtlCacheService {
  private readonly store = new Map<string, Entry>();
  private readonly inflight = new Map<string, Promise<unknown>>();

  /** 同步读：命中返回值，未命中/过期返回 undefined */
  get<T>(key: string): T | undefined {
    const e = this.store.get(key);
    if (!e) return undefined;
    if (Date.now() >= e.expiresAt) {
      this.store.delete(key);
      return undefined;
    }
    return e.value as T;
  }

  /** 同步写；ttlMs <= 0 或 value 为 undefined 时不缓存 */
  set(key: string, value: unknown, ttlMs: number): void {
    if (ttlMs <= 0 || value === undefined) return;
    this.store.set(key, { value, expiresAt: Date.now() + ttlMs });
  }

  /**
   * 读缓存，未命中则加载并回填。同 key 并发未命中只会执行一次 loader。
   * 注意：loader 返回 undefined 会被当作未命中（不会被缓存）。
   */
  async getOrLoad<T>(key: string, ttlMs: number, loader: () => Promise<T>): Promise<T> {
    const hit = this.get<T>(key);
    if (hit !== undefined) return hit;

    const pending = this.inflight.get(key);
    if (pending) return pending as Promise<T>;

    const p = (async () => {
      try {
        const value = await loader();
        this.set(key, value, ttlMs);
        return value;
      } finally {
        this.inflight.delete(key);
      }
    })();
    this.inflight.set(key, p);
    return p;
  }

  /** 失效缓存：不传前缀清空全部，传前缀删除以该前缀开头的所有键 */
  invalidate(prefix?: string): void {
    if (!prefix) {
      this.store.clear();
      return;
    }
    for (const key of this.store.keys()) {
      if (key.startsWith(prefix)) this.store.delete(key);
    }
  }

  /** 当前有效条目数（测试/观测用） */
  size(): number {
    return this.store.size;
  }
}
