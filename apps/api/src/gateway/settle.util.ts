/**
 * 响应先行、结算后台：把与响应无关的落地写（用量落账、渠道健康度、路由指标）
 * 从响应路径上摘出去——客户端不该等一次 DB 事务 + Redis 写完才拿到结果。
 *
 * 调用约定：先 `res.json()` / `res.end()`（或至少发起它们），再把已经发起的
 * Promise 交进来；本函数不返回、不 await，调用方无需也不能再等它。
 *
 * 用 allSettled 兜底：这些写操作内部各自吞错（usage.record 明细写失败只记日志），
 * 但取倍率/定价这类前置阶段仍可能抛错——后台失败只能落在这里，绝不能变成
 * unhandledRejection 干扰进程。
 */
export function settleInBackground(tasks: Promise<unknown>[]): void {
  void Promise.allSettled(tasks);
}
