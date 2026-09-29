import { useEffect } from 'react';
import { useTranslation } from 'react-i18next';

const BASE = 'AI Gateway';

/** 设置 document.title；SPA 全局没有 <title> 管理库，进入页面时统一调用 */
export default function useDocumentTitle(title?: string) {
  const { t, i18n } = useTranslation();
  useEffect(() => {
    document.title = title ? `${title} · ${BASE}` : `${BASE} · ${t('common.docTitle')}`;
    // i18n.language：无标题页面也跟随语言切换刷新
  }, [title, t, i18n.language]);
}
