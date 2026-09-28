import type { ReactNode } from 'react';
import { Typography } from 'antd';

/** DESIGN.md §5 PageHeader：H3 标题 + 可选 --text-3 描述 + 右侧 cluster 操作区 */
export function PageHeader({
  title,
  description,
  extra,
}: {
  title: string;
  description?: string;
  extra?: ReactNode;
}) {
  return (
    <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 16 }}>
      <div>
        <Typography.Title level={4} style={{ margin: 0 }}>
          {title}
        </Typography.Title>
        {description && (
          <Typography.Text type="secondary" style={{ display: 'block', marginTop: 4, fontSize: 13 }}>
            {description}
          </Typography.Text>
        )}
      </div>
      {extra && <div>{extra}</div>}
    </div>
  );
}
