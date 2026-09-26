import { Injectable, NotFoundException } from '@nestjs/common';
import { ApiKeyStatus } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { CryptoService } from '../common/crypto.service';
import { CreateKeyDto } from './dto/create-key.dto';
import { UpdateKeyDto } from './dto/update-key.dto';

@Injectable()
export class KeysService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly crypto: CryptoService,
  ) {}

  async list(userId: string) {
    const keys = await this.prisma.apiKey.findMany({
      where: { userId },
      orderBy: { createdAt: 'desc' },
    });
    return keys.map((k) => this.publicView(k));
  }

  private publicView(k: {
    id: string;
    name: string;
    keyPrefix: string;
    status: ApiKeyStatus;
    quotaLimit: number | null;
    quotaUsed: number;
    costLimit: unknown;
    costUsed: unknown;
    rpmLimit: number | null;
    expiresAt: Date | null;
    lastUsedAt: Date | null;
    createdAt: Date;
  }) {
    return {
      id: k.id,
      name: k.name,
      keyPrefix: `${k.keyPrefix}...`,
      status: k.status,
      quotaLimit: k.quotaLimit,
      quotaUsed: k.quotaUsed,
      costLimit: k.costLimit,
      costUsed: k.costUsed,
      rpmLimit: k.rpmLimit,
      expiresAt: k.expiresAt,
      lastUsedAt: k.lastUsedAt,
      createdAt: k.createdAt,
    };
  }

  async create(userId: string, dto: CreateKeyDto) {
    const { plaintext, hash, prefix } = this.crypto.generateApiKey();
    const key = await this.prisma.apiKey.create({
      data: {
        userId,
        name: dto.name,
        keyHash: hash,
        keyPrefix: prefix,
        quotaLimit: dto.quotaLimit ?? null,
        costLimit: dto.costLimit ?? null,
        rpmLimit: dto.rpmLimit ?? null,
        expiresAt: dto.expiresAt ? new Date(dto.expiresAt) : null,
      },
    });
    // plaintext returned ONLY once
    return {
      ...this.publicView(key),
      plaintext,
      warning: 'Store this key now. It will not be shown again.',
    };
  }

  private async findOwned(userId: string, id: string) {
    const key = await this.prisma.apiKey.findFirst({ where: { id, userId } });
    if (!key) throw new NotFoundException('API key not found');
    return key;
  }

  async update(userId: string, id: string, dto: UpdateKeyDto) {
    await this.findOwned(userId, id);
    const data: Record<string, unknown> = {};
    if (dto.name !== undefined) data.name = dto.name;
    if (dto.status !== undefined) data.status = dto.status;
    if (dto.quotaLimit !== undefined) data.quotaLimit = dto.quotaLimit;
    if (dto.costLimit !== undefined) data.costLimit = dto.costLimit;
    if (dto.rpmLimit !== undefined) data.rpmLimit = dto.rpmLimit;
    if (dto.expiresAt !== undefined) {
      data.expiresAt = dto.expiresAt ? new Date(dto.expiresAt) : null;
    }
    const key = await this.prisma.apiKey.update({ where: { id }, data });
    return this.publicView(key);
  }

  async remove(userId: string, id: string) {
    await this.findOwned(userId, id);
    await this.prisma.apiKey.delete({ where: { id } });
    return { success: true };
  }
}
