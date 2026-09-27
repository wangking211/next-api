import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig({
  plugins: [react()],
  build: {
    // antd 生态（antd + rc-* + @ant-design/*）约 1MB（gzip ~330kB）：rc-* 与图标集都会
    // 引用 @ant-design/cssinjs，任何按包拆分都会产生循环 chunk，只能整体同组，无法压到
    // 500kB 以内，故将告警阈值设为 1100kB。
    chunkSizeWarningLimit: 1100,
    rollupOptions: {
      output: {
        // 用「最后一个 node_modules/ 段」精确识别包名：pnpm 会把 peer 依赖编进目录名
        // （如 antd@5.22.7_react-dom@18.3.1），基于子串匹配会误判依赖归属。
        manualChunks(id) {
          const idx = id.lastIndexOf('node_modules/');
          if (idx === -1) return;
          const parts = id.slice(idx + 'node_modules/'.length).split('/');
          const pkg =
            parts[0].startsWith('@') && parts[1] ? `${parts[0]}/${parts[1]}` : parts[0];
          // react 生态连同其运行时依赖打包在一起，避免 react <-> vendor 循环
          if (
            /^(react|react-dom|react-router|react-router-dom|scheduler|use-sync-external-store|@remix-run\/router)$/.test(
              pkg,
            )
          )
            return 'react';
          // antd 及其内部组件生态必须同组（见上方说明）
          if (
            pkg === 'antd' ||
            pkg.startsWith('@ant-design/') ||
            pkg.startsWith('rc-') ||
            pkg.startsWith('@rc-component/')
          )
            return 'antd';
          if (pkg.startsWith('@tanstack/') || pkg === 'axios') return 'query';
          return 'vendor';
        },
      },
    },
  },
  server: {
    port: 5173,
    proxy: {
      '/api': {
        target: 'http://localhost:3000',
        changeOrigin: true,
      },
      // OpenAI 兼容网关（供本地 SDK / opencode 等经 5173 调用，支持 SSE 流式）
      '/v1': {
        target: 'http://localhost:3000',
        changeOrigin: true,
      },
    },
  },
});
