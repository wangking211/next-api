import i18n from 'i18next';
import { initReactI18next } from 'react-i18next';
import zhCN from './locales/zh-CN';
import zhHant from './locales/zh-Hant';
import en from './locales/en';

/** 可选语言（label 即切换器展示文本，不参与翻译） */
export const LANGS = [
  { code: 'zh-CN', label: '简体中文' },
  { code: 'zh-Hant', label: '繁體中文' },
  { code: 'en', label: 'English' },
] as const;

export type LangCode = (typeof LANGS)[number]['code'];

const STORE_KEY = 'aigw.lang';

function initialLang(): LangCode {
  try {
    const saved = localStorage.getItem(STORE_KEY);
    if (saved === 'zh-CN' || saved === 'zh-Hant' || saved === 'en') return saved;
  } catch {
    /* localStorage 不可用（隐私模式等）时回退到浏览器语言 */
  }
  const nav = typeof navigator !== 'undefined' ? navigator.language.toLowerCase() : '';
  if (nav.startsWith('zh')) {
    return nav.includes('tw') || nav.includes('hk') || nav.includes('mo') ? 'zh-Hant' : 'zh-CN';
  }
  if (nav.startsWith('en')) return 'en';
  return 'zh-CN'; // 默认简体中文（主要用户群）
}

const lng = initialLang();

void i18n.use(initReactI18next).init({
  resources: {
    'zh-CN': { translation: zhCN },
    'zh-Hant': { translation: zhHant },
    en: { translation: en },
  },
  lng,
  fallbackLng: 'zh-CN',
  // 字典为扁平键（'keys.title'），关闭分隔符按整键精确匹配
  keySeparator: false,
  nsSeparator: false,
  interpolation: { escapeValue: false },
  returnNull: false,
});

document.documentElement.lang = lng;

/** 切换语言：更新 i18next、持久化偏好、同步 <html lang>（antd locale 由 main.tsx 联动） */
export function setLang(code: LangCode): void {
  void i18n.changeLanguage(code);
  try {
    localStorage.setItem(STORE_KEY, code);
  } catch {
    /* ignore */
  }
  document.documentElement.lang = code;
}

export default i18n;
