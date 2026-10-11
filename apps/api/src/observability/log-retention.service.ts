import { Injectable, Logger, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { PrismaService } from '../prisma/prisma.service';

const DAY_MS = 24 * 60 * 60 * 1000;
/** 单批删除行数：分批避免长事务锁表（deleteMany 不支持 take，先取 id 再按 id 删） */
const BATCH_SIZE = 5_000;
/** 无更多数据时的轮询间隔：留一小段让出 DB，也避免空转 */
const IDLE_GAP_MS = 1_000;

function num(config: ConfigService, key: string, fallback: number): number {
  const v = Number(config.get<string>(key, ''));
  return Number.isFinite(v) && v > 0 ? v : fallback;
}

/**
 * 请求日志保留期清理：REQUEST_LOG_RETENTION_DAYS 天前的 RequestLog 分批删除。
 *
 * - 默认 0 = 关闭（不配置则永不清理）；生产服务器 .env 设 180
 * - 每日一轮（初始延迟避开启动高峰），定时器 unref 不阻塞进程退出
 * - 分批取 id 再 deleteMany，避免一次删除长事务；删除量大时持续循环直到清空
 */
@Injectable()
export class LogRetentionService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(LogRetentionService.name);
  private readonly retentionDays: number;
  private readonly intervalMs: number;
  private timer?: NodeJS.Timeout;
  private running = false;

  constructor(
    private readonly prisma: PrismaService,
    config: ConfigService,
  ) {
    // 0/未配置/非法 = 关闭；仅 >0 生效
    this.retentionDays = Number(config.get<string>('REQUEST_LOG_RETENTION_DAYS', '0')) || 0;
    this.intervalMs = num(config, 'REQUEST_LOG_RETENTION_INTERVAL_MS', DAY_MS);
  }

  onModuleInit(): void {
    if (this.retentionDays <= 0) {
      this.logger.log('请求日志保留期清理未启用（REQUEST_LOG_RETENTION_DAYS 未设置或为 0）');
      return;
    }
    this.timer = setTimeout(() => {
      this.timer = setInterval(() => void this.runOnce(), this.intervalMs);
      this.timer.unref();
      void this.runOnce();
    }, this.intervalMs);
    this.timer.unref();
  }

  onModuleDestroy(): void {
    if (this.timer) clearTimeout(this.timer);
    this.timer = undefined;
  }

  /** 一轮清理：循环分批删除直到没有过期行；并发保护（定时器与手动触发不重叠） */
  async runOnce(): Promise<void> {
    if (this.running) return;
    this.running = true;
    try {
      const cutoff = new Date(Date.now() - this.retentionDays * DAY_MS);
      let total = 0;
      // 上限保护：单轮最多删 200 万行，剩余的下一轮继续，避免长时间占用 DB
      const maxRounds = 400;
      for (let round = 0; round < maxRounds; round++) {
        const rows = await this.prisma.requestLog.findMany({
          where: { createdAt: { lt: cutoff } },
          select: { id: true },
          take: BATCH_SIZE,
        });
        if (rows.length === 0) break;
        const res = await this.prisma.requestLog.deleteMany({
          where: { id: { in: rows.map((r) => r.id) } },
        });
        total += res.count;
        if (rows.length < BATCH_SIZE) break;
        await new Promise((r) => setTimeout(r, IDLE_GAP_MS));
      }
      if (total > 0) {
        this.logger.log(
          `请求日志清理完成：删除 ${total} 行（保留 ${this.retentionDays} 天，截止 ${cutoff.toISOString()}）`,
        );
      }
    } catch (e) {
      this.logger.warn(`请求日志清理失败: ${(e as Error)?.message ?? e}`);
    } finally {
      this.running = false;
    }
  }
}
