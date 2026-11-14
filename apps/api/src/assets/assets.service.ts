import { BadRequestException, Injectable, Logger, NotFoundException } from '@nestjs/common';
import { AssetKind, AssetStatus, Prisma } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { CosStorageService, extForContentType } from './cos-storage.service';
import { AssetCaptureService } from './asset-capture.service';

export interface AssetQuery {
  page?: number;
  pageSize?: number;
  kind?: string;
  status?: string;
  model?: string;
  /** 管理员按用户过滤 */
  userId?: string;
}

const KINDS = new Set<string>(Object.values(AssetKind));
const STATUSES = new Set<string>(Object.values(AssetStatus));

/**
 * 制成品查询/删除/下载。写入与抓取编排在 AssetCaptureService。
 *
 * 权限口径与控制台日志一致：传入 null = 管理员全量，否则只返回该用户的行。
 */
@Injectable()
export class AssetsService {
  private readonly logger = new Logger(AssetsService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly cos: CosStorageService,
    private readonly capture: AssetCaptureService,
  ) {}

  async list(scopedUserId: string | null, q: AssetQuery = {}) {
    const page = q.page && q.page > 0 ? q.page : 1;
    const pageSize = q.pageSize && q.pageSize > 0 ? Math.min(q.pageSize, 100) : 24;
    const where: Prisma.MediaAssetWhereInput = {
      ...(scopedUserId ? { userId: scopedUserId } : {}),
      ...(q.userId && !scopedUserId ? { userId: q.userId } : {}),
      ...(q.kind && KINDS.has(q.kind) ? { kind: q.kind as AssetKind } : {}),
      ...(q.status && STATUSES.has(q.status) ? { status: q.status as AssetStatus } : {}),
      ...(q.model ? { model: { contains: q.model, mode: 'insensitive' } } : {}),
    };
    const [rows, total] = await Promise.all([
      this.prisma.mediaAsset.findMany({
        where,
        orderBy: { createdAt: 'desc' },
        skip: (page - 1) * pageSize,
        take: pageSize,
        include: {
          user: { select: { id: true, username: true } },
          channel: { select: { id: true, name: true, provider: true } },
        },
      }),
      this.prisma.mediaAsset.count({ where }),
    ]);
    return { items: rows.map((r) => this.view(r)), total, page, pageSize };
  }

  async detail(scopedUserId: string | null, id: string) {
    const row = await this.prisma.mediaAsset.findFirst({
      where: { id, ...(scopedUserId ? { userId: scopedUserId } : {}) },
      include: {
        user: { select: { id: true, username: true } },
        channel: { select: { id: true, name: true, provider: true } },
      },
    });
    if (!row) throw new NotFoundException({ code: 'ASSET_NOT_FOUND', message: 'Asset not found' });
    return this.view(row);
  }

  /** 单条预签名下载地址（私有桶，默认 1 小时有效） */
  async downloadUrl(scopedUserId: string | null, id: string) {
    const row = await this.prisma.mediaAsset.findFirst({
      where: { id, ...(scopedUserId ? { userId: scopedUserId } : {}) },
      select: { id: true, status: true, storageKey: true },
    });
    if (!row) throw new NotFoundException({ code: 'ASSET_NOT_FOUND', message: 'Asset not found' });
    if (row.status !== AssetStatus.READY || !row.storageKey) {
      throw new BadRequestException({
        code: 'ASSET_NOT_READY',
        message: 'Asset is not ready yet',
      });
    }
    const url = this.cos.signedUrl(row.storageKey);
    if (!url)
      throw new BadRequestException({
        code: 'ASSET_STORAGE_DISABLED',
        message: 'Object storage is not configured',
      });
    return {
      url,
      expiresAt: new Date(Date.now() + this.cos.presignTtlSec * 1000).toISOString(),
    };
  }

  /**
   * 下载代理所需的元数据：返回 COS 预签名地址与文件信息。
   * 前端用 `GET /api/assets/:id/content` 走网关取流，避免跨域与 `download` 失效。
   */
  async contentMeta(scopedUserId: string | null, id: string) {
    const row = await this.prisma.mediaAsset.findFirst({
      where: { id, ...(scopedUserId ? { userId: scopedUserId } : {}) },
      select: { id: true, status: true, storageKey: true, contentType: true, bytes: true },
    });
    if (!row) throw new NotFoundException({ code: 'ASSET_NOT_FOUND', message: 'Asset not found' });
    if (row.status !== AssetStatus.READY || !row.storageKey) {
      throw new BadRequestException({
        code: 'ASSET_NOT_READY',
        message: 'Asset is not ready yet',
      });
    }
    const url = this.cos.signedUrl(row.storageKey);
    if (!url) {
      throw new BadRequestException({
        code: 'ASSET_STORAGE_DISABLED',
        message: 'Object storage is not configured',
      });
    }
    const contentType = row.contentType || 'application/octet-stream';
    return {
      url,
      contentType,
      bytes: row.bytes,
      filename: `asset-${row.id}.${extForContentType(contentType)}`,
    };
  }

  /** 重新抓取（仅未就绪/失败的成品；已就绪直接返回） */
  async retry(scopedUserId: string | null, id: string) {
    const row = await this.prisma.mediaAsset.findFirst({
      where: { id, ...(scopedUserId ? { userId: scopedUserId } : {}) },
      select: { id: true, status: true },
    });
    if (!row) throw new NotFoundException({ code: 'ASSET_NOT_FOUND', message: 'Asset not found' });
    if (row.status === AssetStatus.READY) return { id, status: row.status };
    await this.prisma.mediaAsset.update({
      where: { id: row.id },
      data: { status: AssetStatus.PENDING, error: null },
    });
    void this.capture.captureAsset(row.id);
    return { id, status: AssetStatus.PENDING };
  }

  async remove(scopedUserId: string | null, id: string) {
    const row = await this.prisma.mediaAsset.findFirst({
      where: { id, ...(scopedUserId ? { userId: scopedUserId } : {}) },
      select: { id: true, storageKey: true },
    });
    if (!row) throw new NotFoundException({ code: 'ASSET_NOT_FOUND', message: 'Asset not found' });
    // 先删对象再删行：对象删除失败只记日志（残留可由 purge 前缀清理兜底）
    if (row.storageKey) await this.cos.remove(row.storageKey);
    await this.prisma.mediaAsset.delete({ where: { id: row.id } });
    return { deleted: 1 };
  }

  /**
   * 一键清空制成品：删除 COS 前缀下全部对象 + 清空 MediaAsset 表。
   * 仅管理员可用（控制器校验）；不可恢复。
   */
  async purgeAll() {
    let deletedObjects = 0;
    if (this.cos.enabled) {
      deletedObjects = await this.cos.purgePrefix();
    }
    const rows = await this.prisma.mediaAsset.deleteMany({});
    this.logger.warn(`制成品一键清理：对象 ${deletedObjects} 个，记录 ${rows.count} 条`);
    return { deletedObjects, deletedRecords: rows.count, prefix: this.cos.prefix };
  }

  /** 对外视图：默认带 1 小时预签名地址，前端可直接播放/下载 */
  private view(row: {
    id: string;
    kind: AssetKind;
    status: AssetStatus;
    model: string;
    sourceTaskId: string | null;
    sourceUrl: string | null;
    storageKey: string | null;
    bytes: number | null;
    contentType: string | null;
    width: number | null;
    height: number | null;
    durationSeconds: number | null;
    meta: Prisma.JsonValue;
    error: string | null;
    createdAt: Date;
    readyAt: Date | null;
    user?: { id: string; username: string } | null;
    channel?: { id: string; name: string; provider: string } | null;
  }) {
    const url =
      row.status === AssetStatus.READY && row.storageKey
        ? this.cos.signedUrl(row.storageKey)
        : null;
    return {
      id: row.id,
      kind: row.kind,
      status: row.status,
      model: row.model,
      sourceTaskId: row.sourceTaskId,
      sourceUrl: row.sourceUrl,
      bytes: row.bytes,
      contentType: row.contentType,
      width: row.width,
      height: row.height,
      durationSeconds: row.durationSeconds,
      meta: row.meta,
      error: row.error,
      createdAt: row.createdAt,
      readyAt: row.readyAt,
      user: row.user ?? null,
      channel: row.channel ?? null,
      url,
      urlExpiresAt: url ? new Date(Date.now() + this.cos.presignTtlSec * 1000).toISOString() : null,
    };
  }
}
