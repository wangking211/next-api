import { Button, Form, Input, Select, Space } from 'antd';
import { ReloadOutlined } from '@ant-design/icons';
import { useTranslation } from 'react-i18next';
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
  const { t } = useTranslation();
  // 筛选表单自持实例：重置按钮只清自己的字段，不碰新建/编辑弹窗的表单
  const [form] = Form.useForm();
  return (
    <Form
      form={form}
      layout="inline"
      style={{ marginBottom: 16, rowGap: 8 }}
      onFinish={(v: Filters) => onSearch(v)}
    >
      <Form.Item name="name">
        <Input allowClear placeholder={t('channels.filter.name')} style={{ width: 150 }} />
      </Form.Item>
      <Form.Item name="provider">
        <Select
          allowClear
          placeholder={t('channels.filter.provider')}
          style={{ width: 150 }}
          options={PROVIDERS.map((p) => ({ value: p.value, label: p.label() }))}
        />
      </Form.Item>
      <Form.Item name="model">
        <Input allowClear placeholder={t('channels.filter.modelName')} style={{ width: 150 }} />
      </Form.Item>
      <Form.Item name="status">
        <Select
          allowClear
          placeholder={t('common.status')}
          style={{ width: 120 }}
          options={[
            { value: 'ENABLED', label: t('channels.status.enabled') },
            { value: 'DISABLED', label: t('channels.status.disabled') },
          ]}
        />
      </Form.Item>
      {isAdmin && (
        <Form.Item name="ownerType">
          <Select
            allowClear
            placeholder={t('channels.form.ownerType')}
            style={{ width: 120 }}
            options={[
              { value: 'PLATFORM', label: t('channels.status.platform') },
              { value: 'USER', label: t('common.user') },
            ]}
          />
        </Form.Item>
      )}
      <Form.Item>
        <Space>
          <Button type="primary" htmlType="submit">
            {t('channels.filter.query')}
          </Button>
          <Button
            icon={<ReloadOutlined />}
            onClick={() => {
              form.resetFields();
              onReset();
            }}
          >
            {t('channels.filter.reset')}
          </Button>
        </Space>
      </Form.Item>
    </Form>
  );
}
