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
import type { ReactNode } from 'react';
import { QueryClientProvider } from '@tanstack/react-query';
import { BrowserRouter } from 'react-router-dom';
import zhCN from 'antd/locale/zh_CN';
import zhTW from 'antd/locale/zh_TW';
import enUS from 'antd/locale/en_US';
import { useTranslation } from 'react-i18next';
import './i18n';
import App from './App';
import { queryClient } from './api/queryClient';
import MessageBridge from './components/MessageBridge';
import { loadConfig } from './api/config';
import './index.css';

/** 外壳：antd 内置文案（日期选择器/分页/空状态等）跟随 i18n 语言切换 */
function LocaleShell({ children }: { children: ReactNode }) {
  const { i18n } = useTranslation();
  const lang = i18n.language;
  return (
    <ConfigProvider
      locale={lang === 'en' ? enUS : lang === 'zh-Hant' ? zhTW : zhCN}
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
              // 深色菜单项文字在 antd 里由 colorTextLightSolid 推导，而该种子为满足
              // 主按钮「青底深字」被设成近黑 → 深侧栏上近乎不可读。此处按令牌显式改写：
              // 常规项 = --ink-text（深色面上的正文），悬浮 = --brand-link，选中 = --brand
              darkItemColor: '#eef2f5',
              darkItemHoverColor: '#67e8f9',
              darkItemSelectedColor: '#22d3ee',
              darkItemDisabledColor: 'rgba(238, 242, 245, 0.25)',
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
        {children}
      </ConfigProvider>
    );
}

loadConfig().finally(() => {
  ReactDOM.createRoot(document.getElementById('root')!).render(
    <React.StrictMode>
      <LocaleShell>
        <AntApp>
          <MessageBridge />
          <QueryClientProvider client={queryClient}>
            <BrowserRouter>
              <App />
            </BrowserRouter>
          </QueryClientProvider>
        </AntApp>
      </LocaleShell>
    </React.StrictMode>,
  );
});
