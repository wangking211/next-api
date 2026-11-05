import { Button, Dropdown } from 'antd';
import { PayCircleOutlined } from '@ant-design/icons';
import { useTranslation } from 'react-i18next';
import { setCurrency, useCurrency, type DisplayCurrency } from '../utils/format';

/**
 * 展示币种切换器（顶栏通用）：积分 / USD / CNY。
 * 只影响展示换算（USD 记账值 × 系数），不改变记账本位与扣费口径。
 */
export function CurrencySwitch() {
  const { t } = useTranslation();
  const currency = useCurrency();
  const label = currency === 'credits' ? t('common.unit.credits') : currency.toUpperCase();
  return (
    <Dropdown
      trigger={['click']}
      menu={{
        items: [
          { key: 'credits', label: t('common.unit.credits') },
          { key: 'usd', label: 'USD' },
          { key: 'cny', label: 'CNY' },
        ],
        selectedKeys: [currency],
        onClick: ({ key }) => setCurrency(key as DisplayCurrency),
      }}
    >
      <Button
        type="text"
        size="small"
        icon={<PayCircleOutlined />}
        aria-label={t('common.switchCurrency')}
      >
        {label}
      </Button>
    </Dropdown>
  );
}
