import { beforeEach, describe, expect, it } from 'vitest';
import i18n from '../i18n';
import { errorMessage, httpStatus } from './errorMessage';

/** 造一个 axios 风格的错误对象（只用到 response.status / response.data / code / message） */
function axiosError(data?: unknown, status = 400, code?: string): unknown {
  return { code, response: { status, data } };
}

beforeEach(async () => {
  await i18n.changeLanguage('zh-CN');
});

/**
 * 断言「拿到的是译文而不是 i18n 键」：i18n.t 在键缺失时原样返回键，
 * 只比对 t() 会被漏配的键骗过，必须再断言不是键本身。
 *
 * 项目开了 i18next 严格键类型（键是字面量联合），这里接收的是普通 string，
 * 所以把 t 收窄成 (key: string) => string 再用。
 */
const t = i18n.t.bind(i18n) as (key: string) => string;

function expectLocalized(msg: string, key: string): void {
  expect(msg).toBe(t(key));
  expect(msg).not.toBe(key);
}

describe('错误码优先级', () => {
  it('稳定 code 优先于后端 message，并本地化', () => {
    const msg = errorMessage(axiosError({ code: 'API_KEY_NOT_FOUND', message: 'key not found' }));
    expectLocalized(msg, 'err.key.notFound');
    expect(msg).not.toBe('key not found');
  });

  it('details 作为插值参数生成动态文案', () => {
    const msg = errorMessage(
      axiosError({ code: 'CHANNEL_UPSTREAM_ERROR', details: { status: 500, detail: 'boom' } }),
    );
    expect(msg).toBe('上游返回 500：boom');
  });

  it('details 不是对象时不插值（照常返回模板译文）', () => {
    const msg = errorMessage(axiosError({ code: 'CHANNEL_UPSTREAM_ERROR', details: 'oops' }));
    expect(msg).toBe('上游返回 {{status}}：{{detail}}');
  });

  it('未收录的 code 落到 message，不会退化成英文键名', () => {
    expect(errorMessage(axiosError({ code: 'NOT_IN_MAP', message: 'plain words' }))).toBe(
      'plain words',
    );
  });

  it('message 是校验数组时按顺序拼接', () => {
    expect(errorMessage(axiosError({ message: ['name 必填', 'quota 非法'] }))).toBe(
      'name 必填, quota 非法',
    );
  });

  it('嵌套 error.message 作为兜底', () => {
    expect(errorMessage(axiosError({ error: { message: 'nested' } }))).toBe('nested');
  });
});

describe('状态码兜底（既无 code 也无 message）', () => {
  const cases: Array<[number, string]> = [
    [401, 'api.unauthorized'],
    [403, 'api.forbidden'],
    [404, 'api.notFound'],
    [429, 'api.tooManyRequests'],
    [500, 'api.serverError'],
    [502, 'api.serverError'],
  ];

  for (const [status, key] of cases) {
    it(`${status} → ${key}（本地化，不是键名）`, () => {
      expectLocalized(errorMessage(axiosError(undefined, status)), key);
    });
  }

  it('网络层失败（没到服务端）提示网络异常', () => {
    expectLocalized(errorMessage({ code: 'ERR_NETWORK' }), 'api.networkError');
    expectLocalized(errorMessage({ code: 'ECONNABORTED' }), 'api.networkError');
  });

  it('完全未知的错误回退到通用请求失败', () => {
    expectLocalized(errorMessage({}), 'api.requestFailed');
    expectLocalized(errorMessage(null), 'api.requestFailed');
  });

  it('有 Error.message 时保留原始信息（比通用文案更有用）', () => {
    expect(errorMessage(new Error('socket hang up'))).toBe('socket hang up');
  });
});

describe('界面语言切换', () => {
  it('同一错误码在中英文下给出不同文案', async () => {
    const err = axiosError({ code: 'API_KEY_NOT_FOUND', message: 'key not found' });
    await i18n.changeLanguage('zh-CN');
    const zh = errorMessage(err);
    await i18n.changeLanguage('en');
    const en = errorMessage(err);
    // 拿到的是译文而不是 i18n 键，且两种语言确实不同（漏翻会在这里露馅）
    expect(zh).not.toBe('err.key.notFound');
    expect(en).not.toBe('err.key.notFound');
    expect(en).not.toBe(zh);
  });
});

describe('httpStatus', () => {
  it('取响应状态码', () => {
    expect(httpStatus(axiosError(undefined, 429))).toBe(429);
  });

  it('无响应（网络层失败）返回 undefined', () => {
    expect(httpStatus({ code: 'ERR_NETWORK' })).toBeUndefined();
    expect(httpStatus(new Error('x'))).toBeUndefined();
  });
});
