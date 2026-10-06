import react from '@vitejs/plugin-react';
import { defineConfig } from 'vitest/config';

/**
 * 前端单测（Vitest + jsdom + Testing Library）。
 *
 * 与 vite.config.ts 分开：构建配置里不掺测试项，`vitest run` 只读本文件。
 * 覆盖 src 下的 *.spec.{ts,tsx}；端到端另有根目录的 tests/run-e2e.mjs。
 */
export default defineConfig({
  plugins: [react()],
  test: {
    environment: 'jsdom',
    setupFiles: ['./src/test/setup.ts'],
    include: ['src/**/*.spec.{ts,tsx}'],
    // 每个用例还原 vi.spyOn / vi.mock，避免用例间互相污染
    restoreMocks: true,
  },
});
