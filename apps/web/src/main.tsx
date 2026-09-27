import React from 'react';
import ReactDOM from 'react-dom/client';
import { ConfigProvider, App as AntApp } from 'antd';
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
      <ConfigProvider locale={zhCN}>
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
