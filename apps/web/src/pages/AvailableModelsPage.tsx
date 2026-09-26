import { App, Card, Empty, Space, Tag, Typography } from 'antd';
import { useQuery } from '@tanstack/react-query';
import { channelsApi } from '../api/endpoints';

const { Paragraph, Text } = Typography;

export default function AvailableModelsPage() {
  const { message } = App.useApp();
  const { data, isLoading } = useQuery({
    queryKey: ['available-models'],
    queryFn: channelsApi.availableModels,
  });

  const copy = async (text: string) => {
    try {
      await navigator.clipboard.writeText(text);
      message.success(`已复制模型名：${text}`);
    } catch {
      message.warning('复制失败，请手动选择复制');
    }
  };

  return (
    <Space direction="vertical" size={16} style={{ display: 'flex' }}>
      <Card loading={isLoading} title="可用模型（全部）">
        <Paragraph type="secondary">
          调用时只需填写模型名，网关会按「自有渠道优先 → 平台渠道」自动路由（含优先级/权重与故障转移）。点击标签即可复制。
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
          <Empty description="暂无可用模型，请先添加渠道或联系管理员" />
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
                <Tag color="gold">平台</Tag>
              ) : (
                <Tag color="blue">我的</Tag>
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
