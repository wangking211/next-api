import { Button, Dropdown } from 'antd';
import { GlobalOutlined } from '@ant-design/icons';
import { useTranslation } from 'react-i18next';
import { LANGS, setLang, type LangCode } from '../i18n';

/** 语言切换器（顶栏/导航栏通用）：切换后持久化到 localStorage 并同步 antd locale 与 <html lang> */
export function LangSwitch() {
  const { t, i18n } = useTranslation();
  const current = LANGS.find((l) => l.code === i18n.language)?.label ?? LANGS[0].label;
  return (
    <Dropdown
      trigger={['click']}
      menu={{
        items: LANGS.map((l) => ({ key: l.code, label: l.label })),
        selectedKeys: [i18n.language],
        onClick: ({ key }) => setLang(key as LangCode),
      }}
    >
      <Button type="text" size="small" icon={<GlobalOutlined />} aria-label={t('common.switchLang')}>
        {current}
      </Button>
    </Dropdown>
  );
}
