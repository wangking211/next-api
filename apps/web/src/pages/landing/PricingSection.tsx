import { useMemo, useState } from 'react';
import { Empty, Input, Spin } from 'antd';
import { SearchOutlined } from '@ant-design/icons';
import type { PublicModel } from '../../api/types';

const ALL = '__all__';

function money(v: number) {
  if (!Number.isFinite(v)) return '—';
  if (v === 0) return '0';
  if (v >= 1) return v.toFixed(2);
  return String(Number(v.toFixed(4)));
}

export default function PricingSection({
  data,
  loading,
}: {
  data?: { items: PublicModel[]; providers: string[]; count: number };
  loading: boolean;
}) {
  const [q, setQ] = useState('');
  const [provider, setProvider] = useState(ALL);

  const items = data?.items ?? [];

  const filtered = useMemo(() => {
    const keyword = q.trim().toLowerCase();
    return items.filter((m) => {
      if (provider !== ALL && m.provider !== provider) return false;
      if (!keyword) return true;
      return (
        m.name.toLowerCase().includes(keyword) ||
        m.displayName.toLowerCase().includes(keyword) ||
        m.provider.toLowerCase().includes(keyword)
      );
    });
  }, [items, q, provider]);

  return (
    <div>
      <div className="lp-pricing-tools">
        <Input
          className="lp-search"
          allowClear
          prefix={<SearchOutlined style={{ color: 'var(--text-3)' }} />}
          placeholder="搜索模型 / 提供商"
          value={q}
          onChange={(e) => setQ(e.target.value)}
          aria-label="搜索模型"
        />
        <div className="lp-chips">
          <button
            type="button"
            className="lp-chip"
            data-active={provider === ALL}
            onClick={() => setProvider(ALL)}
          >
            全部
          </button>
          {(data?.providers ?? []).map((p) => (
            <button
              key={p}
              type="button"
              className="lp-chip"
              data-active={provider === p}
              onClick={() => setProvider(p)}
            >
              {p}
            </button>
          ))}
        </div>
      </div>

      <div className="lp-table-wrap">
        {loading ? (
          <div className="lp-empty">
            <Spin />
            <div style={{ marginTop: 14 }}>正在加载模型定价…</div>
          </div>
        ) : filtered.length === 0 ? (
          <div className="lp-empty">
            <Empty description={items.length === 0 ? '暂未配置可用模型' : '没有匹配的模型'} />
          </div>
        ) : (
          <>
            <div className="lp-table-scroll">
              <table className="lp-table">
                <thead>
                  <tr>
                    <th>模型</th>
                    <th>提供商</th>
                    <th className="r">输入 $/1M</th>
                    <th className="r">输出 $/1M</th>
                    <th className="r">缓存读 $/1M</th>
                  </tr>
                </thead>
                <tbody>
                  {filtered.map((m) => (
                    <tr key={m.name}>
                      <td>
                        <div className="lp-model-name">{m.name}</div>
                        <div className="lp-model-display">{m.displayName}</div>
                      </td>
                      <td>{m.provider}</td>
                      <td className="r">
                        <span className="lp-num">{money(m.inputPrice)}</span>
                      </td>
                      <td className="r">
                        <span className="lp-num">{money(m.outputPrice)}</span>
                      </td>
                      <td className="r">
                        <span className="lp-num">{money(m.cacheReadPrice)}</span>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            <div className="lp-table-foot">
              共 {filtered.length} 个模型 · 价格为上游官方价（美元 / 100 万 tokens），实际扣费按渠道折扣与账号倍率结算。
            </div>
          </>
        )}
      </div>
    </div>
  );
}
