/**
 * 创建 Key 后的连通性自检：用刚拿到的明文 Key 请求网关 /v1/models。
 *
 * 只验证「Key 有效 + 网关可达 + 鉴权链路通」——/v1/models 不计费、不产生
 * token 消耗，是唯一能安全做真实调用的端点。完整 Key 只在创建弹窗里存在，
 * 所以这个入口也只能放那里。
 *
 * 用原生 fetch 而非 axios 客户端：不带控制台 JWT、不挂 401 拦截器，
 * 避免网关侧鉴权失败被误判成控制台会话过期而强制登出。
 */
export type KeyConnectivityResult =
  { ok: true; latencyMs: number; modelCount: number } | { ok: false; detail: string };

export async function testKeyConnectivity(
  plaintext: string,
  fetchImpl: typeof fetch = fetch,
): Promise<KeyConnectivityResult> {
  const started = Date.now();
  try {
    const res = await fetchImpl('/v1/models', {
      headers: { Authorization: `Bearer ${plaintext}` },
    });
    const latencyMs = Date.now() - started;
    if (!res.ok) {
      // 网关错误体按约定保持英文原文（面向 API 消费者），这里原样带回展示
      let detail = `HTTP ${res.status}`;
      try {
        const body = (await res.json()) as { error?: { message?: string } };
        if (body?.error?.message) detail = `${detail}: ${body.error.message}`;
      } catch {
        /* 非 JSON 错误体：保留 HTTP 状态即可 */
      }
      return { ok: false, detail };
    }
    const body = (await res.json()) as { data?: unknown[] };
    return {
      ok: true,
      latencyMs,
      modelCount: Array.isArray(body?.data) ? body.data.length : 0,
    };
  } catch (e) {
    return { ok: false, detail: e instanceof Error ? e.message : String(e) };
  }
}
