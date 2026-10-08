import { Injectable } from '@nestjs/common';

interface VideoTaskRef {
  channelId: string;
  /** 对外规范模型名（用于状态查询时重新路由到同一渠道） */
  model: string;
  userId: string;
  at: number;
}

/**
 * 视频任务 → 渠道 的进程内映射。
 *
 * 视频是异步任务：`POST /v1/videos` 在某个上游渠道建任务，随后的
 * `GET /v1/videos/{id}` / `.../content` 必须问同一家上游。任务 id 里没有渠道信息，
 * 所以建任务成功后在这里记一笔。
 *
 * 纯内存、不落库：进程重启（发布/扩缩容）后映射丢失，此时由
 * ChannelResolverService 按「模型目录里标了 video 能力的模型」重新探测候选渠道兜底
 * （见 VideoExecutorService.videoCandidates），代价是多一次 404 探测。
 */
@Injectable()
export class VideoTaskService {
  private readonly map = new Map<string, VideoTaskRef>();

  /** 上游任务一般 24h 过期，映射保留同样时长即可 */
  private static readonly TTL_MS = 24 * 60 * 60 * 1000;
  /** 容量上限：到顶先清过期项，仍超限则整体重建（内存兜底） */
  private static readonly MAX_ENTRIES = 5_000;

  remember(taskId: string, ref: Omit<VideoTaskRef, 'at'>): void {
    if (!taskId) return;
    if (this.map.size >= VideoTaskService.MAX_ENTRIES) this.prune();
    this.map.set(taskId, { ...ref, at: Date.now() });
  }

  lookup(taskId: string): VideoTaskRef | undefined {
    const hit = this.map.get(taskId);
    if (!hit) return undefined;
    if (Date.now() - hit.at > VideoTaskService.TTL_MS) {
      this.map.delete(taskId);
      return undefined;
    }
    return hit;
  }

  /**
   * 按属主分类查询（网关状态/内容查询的准入规则）：
   * - `missing`：无映射 → 调用方可走「逐渠道探测」兜底（进程重启后映射丢失的场景）；
   * - `owned`：属主一致 → 正常放行；
   * - `foreign`：有映射但属主不符 → 调用方必须按未知任务处理（404 video_task_not_found）
   *   **且禁止走探测兜底**，否则任何持有效 Key 的用户凭 taskId 就能查状态、
   *   下载他人成片（横向越权）。
   */
  classify(
    taskId: string,
    userId: string,
  ): { state: 'missing' } | { state: 'owned'; ref: VideoTaskRef } | { state: 'foreign' } {
    const hit = this.lookup(taskId);
    if (!hit) return { state: 'missing' };
    return hit.userId === userId ? { state: 'owned', ref: hit } : { state: 'foreign' };
  }

  size(): number {
    return this.map.size;
  }

  private prune(): void {
    const cutoff = Date.now() - VideoTaskService.TTL_MS;
    for (const [k, v] of this.map) {
      if (v.at < cutoff) this.map.delete(k);
    }
    if (this.map.size >= VideoTaskService.MAX_ENTRIES) this.map.clear();
  }
}
