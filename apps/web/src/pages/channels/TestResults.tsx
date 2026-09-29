import { Alert, Space, Tag, Typography } from 'antd';
import { useTranslation } from 'react-i18next';
import type { ChannelTestResult } from '../../api/types';

export function TestResults({ result }: { result: ChannelTestResult }) {
  const { t } = useTranslation();
  const { summary } = result;
  const tone = summary.failed === 0 ? 'green' : summary.ok === 0 ? 'red' : 'orange';
  return (
    <Space direction="vertical" size={10} style={{ width: '100%' }}>
      <Tag color={tone}>
        {t('channels.test.passed', { ok: summary.ok, total: summary.total })}
      </Tag>
      {result.results.map((r) => (
        <div key={r.model} style={{ borderTop: '1px solid var(--border)', paddingTop: 8 }}>
          <Space wrap>
            <Typography.Text code>{r.model}</Typography.Text>
            {r.ok ? (
              <Tag color="green">
                {t('channels.test.success', { status: r.status, latency: r.latencyMs })}
              </Tag>
            ) : (
              <Tag color="red">
                {t('channels.test.failed')}
                {r.status ? ` · HTTP ${r.status}` : ''} · {r.latencyMs}ms
              </Tag>
            )}
          </Space>
          {r.ok && r.sample ? (
            <div style={{ marginTop: 4, color: 'var(--text-2)', fontSize: 12 }}>
              {t('channels.test.sample', { sample: r.sample })}
            </div>
          ) : null}
          {!r.ok && r.error ? (
            <Alert
              style={{ marginTop: 6 }}
              type="error"
              showIcon
              message={r.error}
              description={
                r.detail && r.detail !== r.error ? (
                  <Typography.Paragraph
                    code
                    copyable
                    style={{ whiteSpace: 'pre-wrap', marginBottom: 0, maxHeight: 140, overflow: 'auto' }}
                  >
                    {r.detail}
                  </Typography.Paragraph>
                ) : undefined
              }
            />
          ) : null}
        </div>
      ))}
    </Space>
  );
}
