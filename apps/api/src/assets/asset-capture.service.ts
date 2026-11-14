import { Injectable, Logger, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { AssetKind, MediaAsset } from '@prisma/client';
import { Readable } from 'node:stream';
import { PrismaService } from '../prisma/prisma.service';
import { CryptoService } from '../common/crypto.service';
import { ProviderRegistry } from '../gateway/providers/provider.registry';
import { CosStorageService, extForContentType } from './cos-storage.service';

/** 上游视频任务通常 24h 过期：超过后不再尝试抓取 */
const VIDEO_TTL_MS = 24 * 60 * 60 * 1000;
/** 单轮扫描的待抓取任务数（避免上游轮询过于集中） */
const SCAN_BATCH = 8;
const DEFAULT_SCAN_INTERVAL_MS = 60_000;

interface RegisterVideoInput {
  userId: string;
  apiKeyId: string;
  channelId: string;
  model: string;
  taskId: string;
  requestLogId?: string;
  meta?: Record<string, unknown>;
}

/**
 * 制成品抓取编排。
 *
 * 触发点（三条，互相幂等，靠 `updateMany(status=PENDING|FAILED → CAPTURING)` 抢占）：
 * 1. 建视频任务成功 → 登记一条 PENDING（此时上游还没产出）
 * 2. 用户轮询状态拿到 `completed` → 立即抓取（`captureVideoTask`）
 * 3. 后台定时补扫（用户没轮询也能入库）
 *
 * 抓取是**旁路**的：不改变任何 `/v1/**` 响应，也不参与计费。
 */
@Injectable()
export class AssetCaptureService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(AssetCaptureService.name);
  private timer?: NodeJS.Timeout;
  private scanning = false;
  private readonly scanIntervalMs: number;
  private readonly captureEnabled: boolean;

  constructor(
    private readonly prisma: PrismaService,
    private readonly cos: CosStorageService,
    private readonly providers: ProviderRegistry,
    private readonly crypto: CryptoService,
    config: ConfigService,
  ) {
    const raw = Number(config.get<string>('ASSET_CAPTURE_INTERVAL_MS', ''));
    this.scanIntervalMs =
      Number.isFinite(raw) && raw >= 10_000 ? Math.floor(raw) : DEFAULT_SCAN_INTERVAL_MS;
    this.captureEnabled = config.get<string>('ASSET_CAPTURE_ENABLED', 'true') !== 'false';
  }

  onModuleInit(): void {
    if (!this.captureEnabled || !this.cos.enabled) {
      this.logger.log('制成品自动抓取未启用（ASSET_CAPTURE_ENABLED=false 或 COS 未配置）');
      return;
    }
    // 初始延迟 30s：避开启动高峰；定时器 unref 不阻塞进程退出
    const kickoff = setTimeout(() => {
      void this.scan();
      this.timer = setInterval(() => void this.scan(), this.scanIntervalMs);
      this.timer.unref();
    }, 30_000);
    kickoff.unref();
    this.timer = kickoff;
  }

  onModuleDestroy(): void {
    if (this.timer) clearTimeout(this.timer);
    this.timer = undefined;
  }

  /** 建视频任务后登记成品（同一上游任务只登记一次） */
  async registerVideo(input: RegisterVideoInput): Promise<string | null> {
    if (!input.taskId) return null;
    try {
      const row = await this.prisma.mediaAsset.upsert({
        where: { sourceTaskId: input.taskId },
        create: {
          userId: input.userId,
          apiKeyId: input.apiKeyId,
          channelId: input.channelId,
          requestLogId: input.requestLogId ?? null,
          kind: AssetKind.VIDEO,
          model: input.model,
          sourceTaskId: input.taskId,
          ...(input.meta ? { meta: input.meta as object } : {}),
        },
        // 已登记则不覆盖：重复建任务/重复回调不能把已就绪的行打回 PENDING
        update: {},
        select: { id: true },
      });
      return row.id;
    } catch (e) {
      this.logger.warn(`成品登记失败 task=${input.taskId}: ${(e as Error)?.message ?? e}`);
      return null;
    }
  }

  /** 回填建任务那笔调用日志（落账是后台异步的） */
  async attachLog(assetId: string, requestLogId: string): Promise<void> {
    if (!assetId || !requestLogId) return;
    try {
      await this.prisma.mediaAsset.updateMany({
        where: { id: assetId, requestLogId: null },
        data: { requestLogId },
      });
    } catch (e) {
      this.logger.warn(`成品日志回填失败 asset=${assetId}: ${(e as Error)?.message ?? e}`);
    }
  }

  /**
   * 用户轮询状态时调用：只有属主本人、且尚未就绪才抓取。
   * 非属主/已就绪一律静默返回（不产生任何对外可见的差异）。
   */
  async captureVideoTask(taskId: string, userId: string): Promise<void> {
    if (!taskId || !this.cos.enabled || !this.captureEnabled) return;
    const row = await this.prisma.mediaAsset.findUnique({
      where: { sourceTaskId: taskId },
      select: { id: true, userId: true, status: true },
    });
    if (!row || row.userId !== userId) return;
    if (row.status === 'READY' || row.status === 'CAPTURING') return;
    void this.captureAsset(row.id);
  }

  /** 图片生成成功后调用：响应里的 url / b64_json 逐张旁路保存 */
  async captureImages(input: {
    userId: string;
    apiKeyId: string;
    channelId: string;
    model: string;
    requestLogId?: string;
    response: Record<string, any>;
  }): Promise<void> {
    if (!this.cos.enabled || !this.captureEnabled) return;
    const items: any[] = Array.isArray(input.response?.data) ? input.response.data : [];
    for (const [index, item] of items.slice(0, 10).entries()) {
      const b64 = typeof item?.b64_json === 'string' && item.b64_json ? item.b64_json : null;
      const url = typeof item?.url === 'string' && item.url ? item.url : null;
      if (!b64 && !url) continue;
      try {
        const row = await this.prisma.mediaAsset.create({
          data: {
            userId: input.userId,
            apiKeyId: input.apiKeyId,
            channelId: input.channelId,
            requestLogId: input.requestLogId ?? null,
            kind: AssetKind.IMAGE,
            model: input.model,
            sourceUrl: url,
            meta: {
              index,
              ...(typeof item?.revised_prompt === 'string'
                ? { revisedPrompt: item.revised_prompt }
                : {}),
            },
          },
          select: { id: true },
        });
        // b64 只在内存里传一次；落库后不再保留（无法二次重试，属预期）
        void this.captureImageRow(row.id, b64);
      } catch (e) {
        this.logger.warn(`图片成品登记失败: ${(e as Error)?.message ?? e}`);
      }
    }
  }

  /** 抓取单条成品（可重试；并发调用由状态抢占互斥） */
  async captureAsset(id: string): Promise<void> {
    const claimed = await this.prisma.mediaAsset.updateMany({
      where: { id, status: { in: ['PENDING', 'FAILED'] } },
      data: { status: 'CAPTURING', error: null },
    });
    if (claimed.count === 0) return; // 已就绪或别的进程正在抓
    const asset = await this.prisma.mediaAsset.findUnique({ where: { id } });
    if (!asset) return;
    try {
      if (!this.cos.enabled) throw new Error('对象存储未配置（COS_*）');
      if (asset.kind === AssetKind.VIDEO) await this.captureVideo(asset);
      else await this.captureImage(asset);
    } catch (e) {
      const msg = (e as Error)?.message || String(e);
      this.logger.warn(`成品抓取失败 asset=${id} model=${asset.model}: ${msg}`);
      await this.markFailed(id, msg);
    }
  }

  // ---- internals ----

  private async captureVideo(asset: MediaAsset): Promise<void> {
    if (!asset.sourceTaskId) throw new Error('视频任务 id 缺失');
    const channel = asset.channelId
      ? await this.prisma.channel.findUnique({ where: { id: asset.channelId } })
      : null;
    if (!channel) throw new Error('渠道已删除，无法回溯上游文件');
    const apiKey = this.crypto.decrypt(channel.apiKeyEnc);
    const provider = this.providers.resolve(channel.provider);
    if (typeof provider.videoContent !== 'function') {
      throw new Error(`渠道 ${channel.provider} 不支持视频内容下载`);
    }
    const res = await provider.videoContent(channel, apiKey, { taskId: asset.sourceTaskId });
    const contentType = res.contentType || 'video/mp4';
    const declared = res.contentLength ? Number(res.contentLength) : undefined;
    const stream = Readable.fromWeb(res.stream as Parameters<typeof Readable.fromWeb>[0]);
    await this.upload(
      asset,
      stream,
      contentType,
      Number.isFinite(declared) && (declared as number) > 0 ? (declared as number) : undefined,
    );
  }

  /** 图片重试路径：只能用登记下来的 sourceUrl（b64 不落库） */
  private async captureImage(asset: MediaAsset): Promise<void> {
    if (!asset.sourceUrl) throw new Error('图片原始数据未留存（b64），无法重试');
    const res = await fetch(asset.sourceUrl, { signal: AbortSignal.timeout(60_000) });
    if (!res.ok) throw new Error(`上游图片下载失败 HTTP ${res.status}`);
    const buf = Buffer.from(await res.arrayBuffer());
    await this.upload(asset, buf, res.headers.get('content-type') || 'image/png');
  }

  private async captureImageRow(id: string, b64: string | null): Promise<void> {
    const claimed = await this.prisma.mediaAsset.updateMany({
      where: { id, status: { in: ['PENDING', 'FAILED'] } },
      data: { status: 'CAPTURING', error: null },
    });
    if (claimed.count === 0) return;
    const asset = await this.prisma.mediaAsset.findUnique({ where: { id } });
    if (!asset) return;
    try {
      if (!this.cos.enabled) throw new Error('对象存储未配置（COS_*）');
      if (b64) {
        const buf = Buffer.from(b64, 'base64');
        await this.upload(asset, buf, sniffImageType(buf));
      } else {
        await this.captureImage(asset);
      }
    } catch (e) {
      const msg = (e as Error)?.message || String(e);
      this.logger.warn(`图片成品抓取失败 asset=${id}: ${msg}`);
      await this.markFailed(id, msg);
    }
  }

  private async upload(
    asset: MediaAsset,
    body: Buffer | Readable,
    contentType: string,
    contentLength?: number,
  ): Promise<void> {
    const key = this.cos.objectKey(asset.userId, asset.id, extForContentType(contentType));
    const bytes = await this.cos.putObject(key, body, contentType, contentLength);
    await this.prisma.mediaAsset.update({
      where: { id: asset.id },
      data: {
        status: 'READY',
        storageKey: key,
        bytes: bytes > 0 ? bytes : null,
        contentType,
        readyAt: new Date(),
        error: null,
      },
    });
  }

  private async markFailed(id: string, message: string): Promise<void> {
    await this.prisma.mediaAsset
      .updateMany({
        where: { id, status: { not: 'READY' } },
        data: { status: 'FAILED', error: message.slice(0, 500) },
      })
      .catch(() => undefined);
  }

  /** 后台补扫：过期标记 + 对近期 PENDING 查上游状态，完成即抓 */
  private async scan(): Promise<void> {
    if (this.scanning) return;
    this.scanning = true;
    try {
      const now = Date.now();
      await this.prisma.mediaAsset.updateMany({
        where: {
          kind: AssetKind.VIDEO,
          status: 'PENDING',
          createdAt: { lt: new Date(now - VIDEO_TTL_MS) },
        },
        data: { status: 'FAILED', error: '上游任务已过期（超过 24 小时），无法抓取' },
      });
      const rows = await this.prisma.mediaAsset.findMany({
        where: {
          kind: AssetKind.VIDEO,
          status: 'PENDING',
          sourceTaskId: { not: null },
          createdAt: { gte: new Date(now - VIDEO_TTL_MS) },
        },
        orderBy: { createdAt: 'asc' },
        take: SCAN_BATCH,
      });
      for (const row of rows) {
        try {
          await this.pollAndCapture(row);
        } catch (e) {
          this.logger.warn(`成品补扫失败 asset=${row.id}: ${(e as Error)?.message ?? e}`);
        }
      }
    } catch (e) {
      this.logger.warn(`成品补扫轮次失败: ${(e as Error)?.message ?? e}`);
    } finally {
      this.scanning = false;
    }
  }

  private async pollAndCapture(asset: MediaAsset): Promise<void> {
    if (!asset.sourceTaskId) return;
    const channel = asset.channelId
      ? await this.prisma.channel.findUnique({ where: { id: asset.channelId } })
      : null;
    if (!channel) {
      await this.markFailed(asset.id, '渠道已删除，无法回溯上游文件');
      return;
    }
    const apiKey = this.crypto.decrypt(channel.apiKeyEnc);
    const provider = this.providers.resolve(channel.provider);
    if (typeof provider.videoStatus !== 'function') return;
    const res = await provider.videoStatus(channel, apiKey, { taskId: asset.sourceTaskId });
    const status = typeof res.json?.status === 'string' ? res.json.status : '';
    if (status === 'failed' || status === 'cancelled') {
      await this.markFailed(asset.id, `上游任务状态：${status}`);
      return;
    }
    if (status === 'completed' || status === 'succeeded') {
      await this.captureAsset(asset.id);
    }
  }
}

/** 从文件头识别图片类型（b64 响应不带 MIME） */
function sniffImageType(buf: Buffer): string {
  if (buf.length >= 8 && buf[0] === 0x89 && buf[1] === 0x50 && buf[2] === 0x4e) return 'image/png';
  if (buf.length >= 3 && buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return 'image/jpeg';
  if (
    buf.length >= 12 &&
    buf.toString('ascii', 0, 4) === 'RIFF' &&
    buf.toString('ascii', 8, 12) === 'WEBP'
  )
    return 'image/webp';
  if (buf.length >= 3 && buf.toString('ascii', 0, 3) === 'GIF') return 'image/gif';
  return 'image/png';
}
