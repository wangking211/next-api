// Dev-only UI tooling (react-grab / react-scan) — gated so they never reach production.
// react-scan: use the root entry + scan() — the published `react-scan/auto` subpath is broken
// (exports map points to ./dist/auto.mjs which the package does not ship; see DESIGN.md §8).
// react-doctor runs as a static scan: `pnpm --filter @ai-gateway/web doctor`.
if (import.meta.env.DEV) {
  void import('react-grab');
  void import('react-scan')
    .then((m) => {
      m.scan();
    })
    .catch(() => {
      /* dev tooling must never break the app */
    });
}

import React from 'react';
import ReactDOM from 'react-dom/client';
import { ConfigProvider, App as AntApp, theme } from 'antd';
import { QueryClientProvider } from '@tanstack/react-query';
import { BrowserRouter } from 'react-router-dom';
import zhCN from 'antd/locale/zh_CN';
import App from './App';
import { queryClient } from './api/queryClient';
import { loadConfig } from './api/config';
import './index.css';

loadConfig().finally(() => {
  ReactDOM.createRoot(document.getElementById('root')!).render(
    <React.StrictMode>
      <ConfigProvider
        locale={zhCN}
        theme={{
          algorithm: theme.darkAlgorithm,
          token: {
            colorPrimary: '#22d3ee',
            colorInfo: '#22d3ee',
            colorSuccess: '#5fc992',
            colorWarning: '#ffbc33',
            colorError: '#ff6363',
            colorLink: '#67e8f9',
            colorBgBase: '#07080a',
            colorTextBase: '#f4f7f8',
            // 主按钮电光青底 + 深字（NVIDIA 式，DESIGN.md §8 对比度 >10:1）
            colorTextLightSolid: '#061016',
            borderRadius: 8,
            fontFamily:
              "-apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, 'Helvetica Neue', Arial, 'PingFang SC', 'Hiragino Sans GB', 'Microsoft YaHei', sans-serif",
          },
          components: {
            Layout: {
              siderBg: '#0a0c0f',
              headerBg: '#101111',
              bodyBg: '#07080a',
            },
            Menu: {
              darkItemBg: '#0a0c0f',
              darkItemSelectedBg: 'rgba(34, 211, 238, 0.12)',
              darkItemHoverBg: 'rgba(34, 211, 238, 0.06)',
            },
            Card: { colorBgContainer: '#101111' },
            Table: { colorBgContainer: '#101111', headerBg: '#16181a' },
            Modal: { contentBg: '#101111', headerBg: '#101111' },
            Drawer: { colorBgElevated: '#101111' },
          },
        }}
      >
        <AntApp>
          <QueryClientProvider client={queryClient}>
            <BrowserRouter>
              <App />
            </BrowserRouter>
          </QueryClientProvider>
        </AntApp>
      </ConfigProvider>
    </React.StrictMode>,
  );
});
