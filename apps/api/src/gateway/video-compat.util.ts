/**
 * `/v1/video/generations` 兼容协议 ↔ OpenAI `/v1/videos` 协议 的双向映射。
 *
 * 兼容协议（部分中转站的「兼容格式」视频入口）：
 *   POST /v1/video/generations      {model, prompt, duration, image} → {task_id, status}
 *   GET  /v1/video/generations/{id} → {task_id, status, url?, format?, metadata?}
 *
 * 内部统一走 OpenAI `/v1/videos`（我们与上游共用的协议），因此兼容入口只是
 * 一层薄适配：请求体改字段、响应体换字段，计费 / 故障转移 / 任务登记全链路复用。
 * 状态枚举两边一致（queued | in_progress | completed | failed），无需转换。
 */

/** 兼容请求体 → OpenAI /videos 请求体：duration → seconds（已给 seconds 时以 seconds 为准） */
export function videoCompatRequestBody(body: Record<string, any>): Record<string, any> {
  const { duration, ...rest } = body ?? {};
  if (duration !== undefined && rest.seconds === undefined) rest.seconds = duration;
  return rest;
}

/** 建任务响应：{id, object, status, ...} → {task_id, status} */
export function videoCompatCreateResponse(json: Record<string, any>): Record<string, any> {
  const id = json?.id;
  return {
    ...(typeof id === 'string' && id ? { task_id: id } : {}),
    status: typeof json?.status === 'string' && json.status ? json.status : 'queued',
  };
}

/**
 * 状态响应：{id, status, progress, seconds, ...} → {task_id, status, url?, format?, metadata?}。
 *
 * 上游 OpenAI 形状没有直链字段（成片要走 `/v1/videos/{id}/content` 取），
 * 因此仅在任务完成时给出我们自己的内容端点绝对地址（客户端沿用同一把 API key 即可下载）。
 */
export function videoCompatStatusResponse(
  json: Record<string, any>,
  contentUrl?: string,
): Record<string, any> {
  const id = json?.id;
  const status = typeof json?.status === 'string' && json.status ? json.status : 'unknown';
  const metadata: Record<string, unknown> = {};
  const seconds = json?.seconds;
  if (seconds !== undefined && seconds !== null && seconds !== '') {
    const duration = Number(seconds);
    if (Number.isFinite(duration)) metadata.duration = duration;
  }
  if (typeof json?.progress === 'number') metadata.progress = json.progress;
  const completed = status === 'completed';
  return {
    ...(typeof id === 'string' && id ? { task_id: id } : {}),
    status,
    ...(completed && contentUrl ? { url: contentUrl, format: 'mp4' } : {}),
    ...(Object.keys(metadata).length > 0 ? { metadata } : {}),
  };
}
