/**
 * 单测全局环境：补齐 jsdom 缺失的浏览器 API，并在每个用例后卸载渲染树。
 * 被 vitest.config.ts 的 setupFiles 引用。
 */
import '@testing-library/jest-dom/vitest';
import { cleanup } from '@testing-library/react';
import { afterEach } from 'vitest';

// antd 的响应式栅格与浮层定位会用到这两个 API，jsdom 默认没有
if (typeof window !== 'undefined') {
  if (!window.matchMedia) {
    window.matchMedia = (query: string): MediaQueryList =>
      ({
        matches: false,
        media: query,
        onchange: null,
        addListener: () => undefined,
        removeListener: () => undefined,
        addEventListener: () => undefined,
        removeEventListener: () => undefined,
        dispatchEvent: () => false,
      }) as unknown as MediaQueryList;
  }

  if (!('ResizeObserver' in window)) {
    class ResizeObserverStub {
      observe(): void {
        /* noop */
      }
      unobserve(): void {
        /* noop */
      }
      disconnect(): void {
        /* noop */
      }
    }
    (window as unknown as { ResizeObserver: typeof ResizeObserverStub }).ResizeObserver =
      ResizeObserverStub;
  }
}

// RTL 不在全局注册 cleanup（本项目关闭 vitest globals），手动卸载，避免用例间串 DOM
afterEach(() => cleanup());
