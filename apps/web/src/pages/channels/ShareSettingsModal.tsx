import { useEffect } from 'react';
import {
  App,
  Button,
  DatePicker,
  Form,
  InputNumber,
  Modal,
  Popconfirm,
  Radio,
  Select,
  Space,
  Typography,
} from 'antd';
import dayjs from 'dayjs';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import { channelsApi } from '../../api/endpoints';
import { errorMessage } from '../../api/client';
import type { ChannelInfo } from '../../api/types';

type Props = {
  channel: ChannelInfo | null;
  isAdmin: boolean;
  onClose: () => void;
};

/**
 * 共享设置独立弹窗（从编辑弹窗拆出）：仅自有渠道有入口（列表共享列点击）。
 * 保存 = 部分更新（PATCH，undefined 不修改、null 清除），后端零改动。
 */
export function ShareSettingsModal({ channel, isAdmin, onClose }: Props) {
  const { t } = useTranslation();
  const { message } = App.useApp();
  const qc = useQueryClient();
  const [form] = Form.useForm();

  useEffect(() => {
    if (!channel) return;
    form.resetFields();
    form.setFieldsValue({
      shareMode: channel.shareMode ?? 'PRIVATE',
      shareUrgency: channel.shareUrgency ?? 'NORMAL',
      shareQuotaCostUsd:
        channel.shareQuotaCostUsd != null ? Number(channel.shareQuotaCostUsd) : undefined,
      shareQuotaRequests: channel.shareQuotaRequests ?? undefined,
      shareUntil: channel.shareUntil ? dayjs(channel.shareUntil) : undefined,
      shareFeeBps: channel.shareFeeBps != null ? channel.shareFeeBps / 100 : undefined,
    });
  }, [channel, form]);

  const saveMut = useMutation({
    mutationFn: async (v: {
      shareMode: string;
      shareUrgency: string;
      shareQuotaCostUsd?: number;
      shareQuotaRequests?: number;
      shareUntil?: dayjs.Dayjs;
      shareFeeBps?: number;
    }) => {
      const payload: Record<string, unknown> = {
        shareMode: v.shareMode,
        shareUrgency: v.shareUrgency,
        // 清空输入框 = 清除限额（发 null，undefined 会被后端视为不修改）
        shareQuotaCostUsd: v.shareQuotaCostUsd ?? null,
        shareQuotaRequests: v.shareQuotaRequests ?? null,
        shareUntil: v.shareUntil ? v.shareUntil.toISOString() : null,
      };
      // 抽成仅管理员可设；表单里是百分比，后端按基点存（1% = 100），留空 = 用全局默认
      if (isAdmin) {
        payload.shareFeeBps =
          typeof v.shareFeeBps === 'number' ? Math.round(v.shareFeeBps * 100) : null;
      }
      return channelsApi.update(channel!.id, payload);
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['channels'] });
      onClose();
      message.success(t('channels.message.channelUpdated'));
    },
    onError: (e) => message.error(errorMessage(e)),
  });

  // 重置共享用量（shareUsedRequests / shareUsedCostUsd 清零），不动累计分成 shareRevenue
  const resetShareMut = useMutation({
    mutationFn: (id: string) => channelsApi.update(id, { resetShareUsed: true }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['channels'] });
      message.success(t('channels.message.shareUsageReset'));
    },
    onError: (e) => message.error(errorMessage(e)),
  });

  // 抽成在表单里是百分比；非管理员看不到该字段，回退到渠道已有的设置（提示文案用）
  const feePercentValue = Form.useWatch('shareFeeBps', form);
  const effectiveFeePercent =
    feePercentValue ?? (channel?.shareFeeBps != null ? channel.shareFeeBps / 100 : undefined);
  const ownerSharePct = 100 - (effectiveFeePercent ?? 20);

  return (
    <Modal
      title={`${t('channels.form.shareSection')} · ${channel?.name ?? ''}`}
      open={!!channel}
      onCancel={onClose}
      onOk={() => form.submit()}
      okText={t('common.save')}
      cancelText={t('common.cancel')}
      confirmLoading={saveMut.isPending}
      destroyOnClose
      width={560}
    >
      <Form form={form} layout="vertical" onFinish={(v) => saveMut.mutate(v)} requiredMark={false}>
        <Space size={16} wrap>
          <Form.Item
            name="shareMode"
            label={t('channels.form.shareMode')}
            tooltip={t('channels.form.shareModeTip')}
          >
            <Radio.Group
              optionType="button"
              options={[
                { label: t('channels.share.private'), value: 'PRIVATE' },
                { label: t('channels.share.group'), value: 'GROUP' },
                { label: t('channels.share.public'), value: 'PUBLIC' },
              ]}
            />
          </Form.Item>
          <Form.Item
            name="shareUrgency"
            label={t('channels.form.shareUrgency')}
            tooltip={t('channels.form.shareUrgencyTip')}
          >
            <Select
              style={{ width: 120 }}
              options={[
                { label: t('channels.share.normal'), value: 'NORMAL' },
                { label: t('channels.share.high'), value: 'HIGH' },
                { label: t('channels.share.flush'), value: 'FLUSH' },
              ]}
            />
          </Form.Item>
          <Form.Item
            name="shareQuotaCostUsd"
            label={t('channels.form.shareQuotaCost')}
            tooltip={t('channels.form.shareQuotaCostTip')}
          >
            <InputNumber
              min={0}
              step={0.5}
              placeholder={t('channels.form.unlimited')}
              style={{ width: 150 }}
            />
          </Form.Item>
          <Form.Item
            name="shareQuotaRequests"
            label={t('channels.form.shareQuotaRequests')}
            tooltip={t('channels.form.shareQuotaRequestsTip')}
          >
            <InputNumber
              min={0}
              placeholder={t('channels.form.unlimited')}
              style={{ width: 150 }}
            />
          </Form.Item>
          <Form.Item
            name="shareUntil"
            label={t('channels.form.shareUntil')}
            tooltip={t('channels.form.shareUntilTip')}
          >
            <DatePicker showTime style={{ width: 210 }} />
          </Form.Item>
          {isAdmin && (
            <Form.Item
              name="shareFeeBps"
              label={t('channels.form.shareFee')}
              tooltip={t('channels.form.shareFeeTip')}
            >
              <InputNumber
                min={0}
                max={100}
                step={1}
                placeholder={t('channels.form.shareFeeDefault')}
                style={{ width: 150 }}
              />
            </Form.Item>
          )}
          {channel && (
            <Popconfirm
              title={t('channels.share.resetUsageConfirm')}
              okText={t('channels.share.resetUsageConfirmOk')}
              cancelText={t('channels.share.resetUsageConfirmCancel')}
              onConfirm={() => resetShareMut.mutate(channel.id)}
            >
              <Button loading={resetShareMut.isPending}>{t('channels.share.resetUsage')}</Button>
            </Popconfirm>
          )}
        </Space>
        <Typography.Text type="secondary" style={{ fontSize: 12 }}>
          {t('channels.form.shareHint', { pct: ownerSharePct })}
        </Typography.Text>
      </Form>
    </Modal>
  );
}
