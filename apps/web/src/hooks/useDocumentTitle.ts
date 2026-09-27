import { useEffect } from 'react';

const BASE = 'AI Gateway';

/** 设置 document.title；SPA 全局没有 <title> 管理库，进入页面时统一调用 */
export default function useDocumentTitle(title?: string) {
  useEffect(() => {
    document.title = title ? `${title} · ${BASE}` : `${BASE} · 多模型 AI API 中转与管理平台`;
  }, [title]);
}
