import { randomBytes } from 'crypto';

// 去除易混淆字符（0/O、1/I 等）
const ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';

export function generateRedeemCode(groups = 4, size = 4): string {
  const total = groups * size;
  const bytes = randomBytes(total);
  let chars = '';
  for (let i = 0; i < total; i++) {
    chars += ALPHABET[bytes[i] % ALPHABET.length];
  }
  const parts: string[] = [];
  for (let g = 0; g < groups; g++) {
    parts.push(chars.slice(g * size, (g + 1) * size));
  }
  return parts.join('-');
}

export function normalizeCode(code: string): string {
  return code.trim().toUpperCase();
}
