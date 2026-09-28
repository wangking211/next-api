import { Button, Form, Input, Select, Space } from 'antd';
import { ReloadOutlined } from '@ant-design/icons';
import { PROVIDERS, type Filters } from './constants';

export function ChannelFilterForm({
  isAdmin,
  onSearch,
  onReset,
}: {
  isAdmin: boolean;
  onSearch: (v: Filters) => void;
  onReset: () => void;
}) {
  return (
    <Form
      layout="inline"
      style={{ marginBottom: 16, rowGap: 8 }}
      onFinish={(v: Filters) => onSearch(v)}
    >
      <Form.Item name="name">
        <Input allowClear placeholder="渠道名称" style={{ width: 150 }} />
      </Form.Item>
      <Form.Item name="provider">
        <Select
          allowClear
          placeholder="服务商"
          style={{ width: 150 }}
          options={PROVIDERS.map((p) => ({ value: p.value, label: p.label }))}
        />
      </Form.Item>
      <Form.Item name="model">
        <Input allowClear placeholder="模型名" style={{ width: 150 }} />
      </Form.Item>
      <Form.Item name="status">
        <Select
          allowClear
          placeholder="状态"
          style={{ width: 120 }}
          options={[
            { value: 'ENABLED', label: '启用' },
            { value: 'DISABLED', label: '停用' },
          ]}
        />
      </Form.Item>
      {isAdmin && (
        <Form.Item name="ownerType">
          <Select
            allowClear
            placeholder="归属"
            style={{ width: 120 }}
            options={[
              { value: 'PLATFORM', label: '平台' },
              { value: 'USER', label: '用户' },
            ]}
          />
        </Form.Item>
      )}
      <Form.Item>
        <Space>
          <Button type="primary" htmlType="submit">
            查询
          </Button>
          <Button icon={<ReloadOutlined />} onClick={onReset}>
            重置
          </Button>
        </Space>
      </Form.Item>
    </Form>
  );
}
