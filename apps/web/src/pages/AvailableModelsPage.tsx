import { App, Card, Empty, Space, Tag, Typography } from 'antd';
import { useQuery } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import { channelsApi } from '../api/endpoints';
import QueryError from '../components/QueryError';
import { useAuth } from '../auth/AuthContext';

const { Paragraph, Text } = Typography;

export default function AvailableModelsPage() {
  const { t } = useTranslation();
  const { message } = App.useApp();
  const { user } = useAuth();
  const { data, isLoading, isError, refetch } = useQuery({
    queryKey: ['available-models'],
    queryFn: ({ signal }) => channelsApi.availableModels(signal),
  });

  const copy = async (text: string) => {
    try {
      await navigator.clipboard.writeText(text);
      message.success(t('models.copiedName', { name: text }));
    } catch {
      message.warning(t('models.copyFailed'));
    }
  };

  return (
    <Space direction="vertical" size={16} style={{ display: 'flex' }}>
      <QueryError show={isError} onRetry={refetch} />

      <Card loading={isLoading} title={t('models.available.title')}>
        <Paragraph type="secondary">
          {t('models.available.help')}
        </Paragraph>
        {data && data.models.length > 0 ? (
          <Space size={[8, 8]} wrap>
            {data.models.map((m) => (
              <Tag
                key={m}
                color="blue"
                style={{ cursor: 'pointer', fontSize: 13, padding: '2px 8px' }}
                onClick={() => copy(m)}
              >
                {m}
              </Tag>
            ))}
          </Space>
        ) : (
          <Empty description={t('models.available.empty')} />
        )}
      </Card>

      {data?.channels.map((ch) => (
        <Card
          key={ch.id}
          size="small"
          title={
            <Space>
              <Text strong>{ch.name}</Text>
              {ch.ownerType === 'PLATFORM' ? (
                <Tag color="gold">{t('models.platform')}</Tag>
              ) : ch.ownerUserId && ch.ownerUserId === user?.id ? (
                <Tag color="blue">{t('models.mine')}</Tag>
              ) : (
                // 别人共享过来的渠道：按共享范围标注，避免误标成「我的」
                <Tag color="purple">
                  {t(
                    ch.shareMode === 'GROUP' ? 'channels.share.group' : 'channels.share.public',
                  )}
                </Tag>
              )}
              <Tag>{ch.provider}</Tag>
            </Space>
          }
        >
          <Space size={[8, 8]} wrap>
            {ch.models.map((m) => (
              <Tag
                key={m}
                style={{ cursor: 'pointer' }}
                onClick={() => copy(m)}
              >
                {m}
              </Tag>
            ))}
          </Space>
        </Card>
      ))}
    </Space>
  );
}
