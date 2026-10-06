import { beforeEach, describe, expect, it } from 'vitest';
import { SESSION_EXPIRED_KEY, consumeSessionExpired, loginPathWithRedirect } from './client';

beforeEach(() => {
  sessionStorage.clear();
  localStorage.clear();
});

describe('loginPathWithRedirect', () => {
  it('站内路径编码进 redirect 参数，登录后可回到原页面', () => {
    expect(loginPathWithRedirect('/keys', '?tab=models')).toBe(
      '/login?redirect=%2Fkeys%3Ftab%3Dmodels',
    );
    expect(loginPathWithRedirect('/logs')).toBe('/login?redirect=%2Flogs');
  });

  it('协议相对 URL（//evil.com）视为站外，丢弃 redirect', () => {
    expect(loginPathWithRedirect('//evil.com/x')).toBe('/login');
  });

  it('绝对 URL / 非 / 开头的输入同样丢弃，防开放重定向', () => {
    expect(loginPathWithRedirect('https://evil.com')).toBe('/login');
    expect(loginPathWithRedirect('keys')).toBe('/login');
  });
});

describe('consumeSessionExpired', () => {
  it('读取一次即清除，重复调用返回 false', () => {
    sessionStorage.setItem(SESSION_EXPIRED_KEY, '1');
    expect(consumeSessionExpired()).toBe(true);
    expect(sessionStorage.getItem(SESSION_EXPIRED_KEY)).toBeNull();
    expect(consumeSessionExpired()).toBe(false);
  });

  it('没有标记时返回 false', () => {
    expect(consumeSessionExpired()).toBe(false);
  });

  it('标记值不是 1 时不算过期', () => {
    sessionStorage.setItem(SESSION_EXPIRED_KEY, '0');
    expect(consumeSessionExpired()).toBe(false);
  });
});
