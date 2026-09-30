import { Alert, Button } from 'antd';
import { useTranslation } from 'react-i18next';

interface Props {
  /** 是否展示（一般直接传 useQuery 的 isError） */
  show: boolean;
  /** 重试回调（一般传 refetch）；不传则不显示按钮 */
  onRetry?: () => void;
  /** 覆盖默认标题；默认复用 Dashboard 的同一套文案 */
  title?: string;
}

/**
 * 列表/详情页统一的「查询失败」提示。
 * 与 DashboardPage 共用 dashboard.alert.* 文案 + common.retry，避免各页自造一套
 * ——同时补上此前列表页查询失败只显示空表的静默问题。
 */
export default function QueryError({ show, onRetry, title }: Props) {
  const { t } = useTranslation();
  if (!show) return null;

  return (
    <Alert
      type="error"
      showIcon
      style={{ marginBottom: 12 }}
      message={title ?? t('dashboard.alert.errorTitle')}
      description={t('dashboard.alert.errorDesc')}
      action={
        onRetry ? (
          <Button size="small" onClick={() => onRetry()}>
            {t('common.retry')}
          </Button>
        ) : undefined
      }
    />
  );
}
