import { useMemo, useState } from 'react';
import { Empty, Input, Spin } from 'antd';
import { SearchOutlined } from '@ant-design/icons';
import { useTranslation } from 'react-i18next';
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
  const { t } = useTranslation();
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
          placeholder={t('landing.pricing.searchPlaceholder')}
          value={q}
          onChange={(e) => setQ(e.target.value)}
          aria-label={t('landing.pricing.searchAria')}
        />
        <div className="lp-chips">
          <button
            type="button"
            className="lp-chip"
            data-active={provider === ALL}
            onClick={() => setProvider(ALL)}
          >
            {t('common.all')}
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
            <div style={{ marginTop: 14 }}>{t('landing.pricing.loading')}</div>
          </div>
        ) : filtered.length === 0 ? (
          <div className="lp-empty">
            <Empty
              description={
                items.length === 0 ? t('landing.pricing.empty') : t('landing.pricing.noMatch')
              }
            />
          </div>
        ) : (
          <>
            <div className="lp-table-scroll">
              <table className="lp-table">
                <thead>
                  <tr>
                    <th>{t('common.model')}</th>
                    <th>{t('landing.pricing.colProvider')}</th>
                    <th className="r">{t('landing.pricing.colInput')}</th>
                    <th className="r">{t('landing.pricing.colOutput')}</th>
                    <th className="r">{t('landing.pricing.colCacheRead')}</th>
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
              {t('landing.pricing.footer', { total: filtered.length })}
            </div>
          </>
        )}
      </div>
    </div>
  );
}
