import { createHash, timingSafeEqual } from 'crypto';

/**
 * JAIPay 签名算法（请求与回调一致）：
 * 1. 过滤空值参数与 sign 字段本身
 * 2. 按参数名不区分大小写升序排序
 * 3. 拼接为 k1=v1&k2=v2...
 * 4. 末尾追加 &key={appSecret}
 * 5. MD5 后转大写
 */
export function jaiPaySign(params: Record<string, unknown>, appSecret: string): string {
  const raw =
    Object.keys(params)
      .filter((k) => {
        if (k === 'sign') return false;
        const v = params[k];
        return v !== undefined && v !== null && `${v}` !== '';
      })
      .sort((a, b) => a.toLowerCase().localeCompare(b.toLowerCase()))
      .map((k) => `${k}=${params[k]}`)
      .join('&') + `&key=${appSecret}`;
  return createHash('md5').update(raw, 'utf8').digest('hex').toUpperCase();
}

/** 校验签名（大小写不敏感，长度一致时用定时安全比较） */
export function jaiPayVerify(params: Record<string, unknown>, appSecret: string): boolean {
  const received = `${params.sign ?? ''}`.trim().toUpperCase();
  if (!received) return false;
  const expected = jaiPaySign(params, appSecret);
  if (received.length !== expected.length) return false;
  return timingSafeEqual(Buffer.from(received), Buffer.from(expected));
}
