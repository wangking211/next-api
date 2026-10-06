import { describe, expect, it, vi } from 'vitest';
import { testKeyConnectivity } from './keyConnectivity';

/** 造一个 fetch 响应桩：只用到 ok / status / json() */
function res(status: number, body: unknown): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
  } as unknown as Response;
}

describe('testKeyConnectivity', () => {
  it('200 + 模型列表 → 成功并返回模型数', async () => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValue(res(200, { object: 'list', data: [{ id: 'm1' }, { id: 'm2' }] }));
    const r = await testKeyConnectivity('sk-test', fetchImpl as never);
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.modelCount).toBe(2);
    expect(fetchImpl).toHaveBeenCalledWith('/v1/models', {
      headers: { Authorization: 'Bearer sk-test' },
    });
  });

  it('200 但 data 不是数组 → 成功且模型数记 0', async () => {
    const r = await testKeyConnectivity('sk-test', (async () =>
      res(200, { object: 'list', data: 'oops' })) as never);
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.modelCount).toBe(0);
  });

  it('401 + OpenAI 错误体 → 失败并带上状态与原始 message', async () => {
    const r = await testKeyConnectivity('sk-bad', (async () =>
      res(401, {
        error: { message: 'Invalid API key', type: 'authentication_error' },
      })) as never);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.detail).toBe('HTTP 401: Invalid API key');
  });

  it('错误体不是 JSON → 只报 HTTP 状态', async () => {
    const bad = {
      ok: false,
      status: 502,
      json: async () => {
        throw new Error('not json');
      },
    } as unknown as Response;
    const r = await testKeyConnectivity('sk-x', (async () => bad) as never);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.detail).toBe('HTTP 502');
  });

  it('网络异常 → 失败并带原始错误信息', async () => {
    const r = await testKeyConnectivity('sk-x', (async () => {
      throw new TypeError('Failed to fetch');
    }) as never);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.detail).toBe('Failed to fetch');
  });
});
