import 'i18next';
import type zhCN from './locales/zh-CN';

declare module 'i18next' {
  interface CustomTypeOptions {
    defaultNS: 'translation';
    /** t() 键以 zh-CN 字典为准做全量类型检查——写错键名/漏建键会直接 typecheck 失败 */
    resources: { translation: typeof zhCN };
  }
}
