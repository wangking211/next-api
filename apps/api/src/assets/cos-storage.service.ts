import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { Readable } from 'node:stream';
import { Transform } from 'node:stream';
import COS from 'cos-nodejs-sdk-v5';

/** 允许的成品 MIME → 扩展名（对象 key 用；未知类型统一 .bin） */
const EXT_BY_TYPE: Record<string, string> = {
  'video/mp4': 'mp4',
  'video/webm': 'webm',
  'video/quicktime': 'mov',
  'image/png': 'png',
  'image/jpeg': 'jpg',
  'image/jpg': 'jpg',
  'image/webp': 'webp',
  'image/gif': 'gif',
};

export function extForContentType(contentType: string | null | undefined): string {
  const type = (contentType ?? '').split(';')[0].trim().toLowerCase();
  return EXT_BY_TYPE[type] ?? 'bin';
}

function normalizePrefix(raw: string | undefined): string {
  const v = (raw ?? '').trim().replace(/^\/+/, '');
  if (!v) return 'aigw-assets/';
  return v.endsWith('/') ? v : `${v}/`;
}

function positiveInt(raw: string | number | undefined, fallback: number): number {
  const n = Number(raw);
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : fallback;
}

/**
 * 腾讯云 COS 存储层（制成品原件）。
 *
 * 设计要点：
 * - **所有对象都在同一个可配置前缀下**（默认 `aigw-assets/`），一键清理只需按前缀
 *   列举并批量删除（见 `purgePrefix`），也可在 COS 控制台给该前缀挂生命周期规则。
 * - 桶保持**私有读**：下载一律发预签名 URL（默认 1 小时），不把对象暴露成公有链接。
 * - 未配置密钥/桶时 `enabled=false`：上层只登记元数据，不会让网关调用失败。
 */
@Injectable()
export class CosStorageService {
  private readonly logger = new Logger(CosStorageService.name);
  private readonly client: COS | null = null;
  private readonly bucket: string;
  private readonly region: string;
  /** 成品对象统一前缀（以 / 结尾） */
  readonly prefix: string;
  /** 未配置凭据时为 false，调用方据此降级 */
  readonly enabled: boolean;
  /** 预签名有效期（秒） */
  readonly presignTtlSec: number;

  constructor(config: ConfigService) {
    const secretId = (config.get<string>('COS_SECRET_ID') ?? '').trim();
    const secretKey = (config.get<string>('COS_SECRET_KEY') ?? '').trim();
    this.bucket = (config.get<string>('COS_BUCKET') ?? '').trim();
    this.region = (config.get<string>('COS_REGION') ?? '').trim();
    this.prefix = normalizePrefix(config.get<string>('ASSET_COS_PREFIX'));
    this.presignTtlSec = positiveInt(config.get<string>('ASSET_PRESIGN_TTL_SEC'), 3600);
    this.enabled = Boolean(secretId && secretKey && this.bucket && this.region);
    if (this.enabled) {
      this.client = new COS({ SecretId: secretId, SecretKey: secretKey });
      this.logger.log(
        `制成品存储已启用：bucket=${this.bucket} region=${this.region} prefix=${this.prefix}`,
      );
    } else {
      this.logger.warn(
        'COS 未配置（COS_SECRET_ID / COS_SECRET_KEY / COS_BUCKET / COS_REGION），制成品只登记元数据、不保存原件',
      );
    }
  }

  /**
   * 生成对象 key：`{prefix}{userId}/{yyyy}/{MM}/{assetId}.{ext}`。
   * 按用户与年月分层，既便于排查，也便于按用户/时间段做生命周期规则。
   */
  objectKey(userId: string, assetId: string, extension: string): string {
    const now = new Date();
    const yyyy = now.getUTCFullYear();
    const mm = String(now.getUTCMonth() + 1).padStart(2, '0');
    const ext = extension ? `.${extension}` : '';
    return `${this.prefix}${userId}/${yyyy}/${mm}/${assetId}${ext}`;
  }

  /**
   * 流式/普通上传。返回实际写入字节数。
   * `ContentLength` 未知时走分块传输，由 COS 侧决定分片。
   */
  async putObject(
    key: string,
    body: Buffer | Readable,
    contentType: string,
    contentLength?: number,
  ): Promise<number> {
    const client = this.requireClient();
    let size = contentLength && contentLength > 0 ? contentLength : 0;
    // Buffer 的大小已知：直接声明长度，避免走分块传输
    if (!size && Buffer.isBuffer(body)) size = body.length;
    let payload: Buffer | Readable = body;
    if (!size && !Buffer.isBuffer(body)) {
      // 边传边计数：上游没给 Content-Length 时也能把真实大小落库
      const counter = new Transform({
        transform(chunk, _enc, cb) {
          size += chunk.length;
          cb(null, chunk);
        },
      });
      payload = body.pipe(counter);
    }
    await client.putObject({
      Bucket: this.bucket,
      Region: this.region,
      Key: key,
      Body: payload as never,
      ContentType: contentType,
      ...(size > 0 ? { ContentLength: size } : {}),
    });
    if (!size && Buffer.isBuffer(body)) size = body.length;
    return size;
  }

  /** 私有桶下载地址（预签名）。未启用返回 null。 */
  signedUrl(key: string, ttlSec = this.presignTtlSec): string | null {
    if (!this.client) return null;
    return this.client.getObjectUrl({
      Bucket: this.bucket,
      Region: this.region,
      Key: key,
      Sign: true,
      Expires: ttlSec,
    });
  }

  /** 删除单个对象（不存在视为成功）。 */
  async remove(key: string): Promise<void> {
    const client = this.requireClient();
    try {
      await client.deleteObject({ Bucket: this.bucket, Region: this.region, Key: key });
    } catch (e) {
      // 404/NoSuchKey 等错误不阻塞行删除：残留对象可由 purgePrefix 兜底
      this.logger.warn(`COS 删除对象失败 key=${key}: ${(e as Error)?.message ?? e}`);
    }
  }

  /**
   * 一键清理：删除当前前缀下的**全部对象**（分批，单批 1000 个）。
   * 返回删除数量。仅管理员接口使用。
   */
  async purgePrefix(): Promise<number> {
    const client = this.requireClient();
    let deleted = 0;
    // 上限保护：单次最多 100 万对象，避免误操作长时间占用进程
    for (let round = 0; round < 1000; round++) {
      const res = await client.getBucket({
        Bucket: this.bucket,
        Region: this.region,
        Prefix: this.prefix,
        MaxKeys: 1000,
      });
      const keys = (res.Contents ?? [])
        .map((o) => o.Key)
        .filter((k): k is string => typeof k === 'string' && k.length > 0);
      if (keys.length === 0) break;
      await client.deleteMultipleObject({
        Bucket: this.bucket,
        Region: this.region,
        Objects: keys.map((Key) => ({ Key })),
      });
      deleted += keys.length;
      if (keys.length < 1000) break;
    }
    return deleted;
  }

  private requireClient(): COS {
    if (!this.client) throw new Error('对象存储未配置（COS_*）');
    return this.client;
  }
}
