import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import {
  createCipheriv,
  createDecipheriv,
  createHash,
  randomBytes,
  randomUUID,
} from 'crypto';

@Injectable()
export class CryptoService {
  private readonly key: Buffer;
  private readonly keyPrefix: string;

  constructor(config: ConfigService) {
    const hex = config.get<string>('ENCRYPTION_KEY', '');
    if (!/^[0-9a-fA-F]{64}$/.test(hex)) {
      throw new Error(
        'ENCRYPTION_KEY must be 32 bytes hex (64 hex chars). Generate with: openssl rand -hex 32',
      );
    }
    this.key = Buffer.from(hex, 'hex');
    this.keyPrefix = config.get<string>('API_KEY_PREFIX', 'sk-');
  }

  /** AES-256-GCM encrypt. Output: base64(iv).base64(authTag).base64(cipher) */
  encrypt(plain: string): string {
    const iv = randomBytes(12);
    const cipher = createCipheriv('aes-256-gcm', this.key, iv);
    const enc = Buffer.concat([cipher.update(plain, 'utf8'), cipher.final()]);
    const tag = cipher.getAuthTag();
    return [iv.toString('base64'), tag.toString('base64'), enc.toString('base64')].join(
      '.',
    );
  }

  decrypt(payload: string): string {
    const [ivB64, tagB64, dataB64] = payload.split('.');
    if (!ivB64 || !tagB64 || !dataB64) {
      throw new Error('Invalid encrypted payload');
    }
    const decipher = createDecipheriv(
      'aes-256-gcm',
      this.key,
      Buffer.from(ivB64, 'base64'),
    );
    decipher.setAuthTag(Buffer.from(tagB64, 'base64'));
    return Buffer.concat([
      decipher.update(Buffer.from(dataB64, 'base64')),
      decipher.final(),
    ]).toString('utf8');
  }

  /** Generate a platform API key like sk-xxxx. Returns plaintext + hash + prefix. */
  generateApiKey(): { plaintext: string; hash: string; prefix: string } {
    const raw = randomBytes(24).toString('base64url');
    const plaintext = `${this.keyPrefix}${raw}`;
    return {
      plaintext,
      hash: this.hashApiKey(plaintext),
      prefix: plaintext.slice(0, this.keyPrefix.length + 6),
    };
  }

  hashApiKey(plaintext: string): string {
    return createHash('sha256').update(plaintext).digest('hex');
  }

  randomId(): string {
    return randomUUID();
  }
}
