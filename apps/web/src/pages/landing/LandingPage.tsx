import { useEffect } from 'react';
import { useQuery } from '@tanstack/react-query';
import { Button } from 'antd';
import {
  AccountBookOutlined,
  ApiOutlined,
  ArrowRightOutlined,
  CloudServerOutlined,
  DeploymentUnitOutlined,
  SafetyCertificateOutlined,
  ThunderboltOutlined,
} from '@ant-design/icons';
import { Link, useLocation } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import type { TFunction } from 'i18next';
import { useAuth } from '../../auth/AuthContext';
import { publicApi } from '../../api/endpoints';
import Logo from '../../components/Logo';
import { LangSwitch } from '../../components/LangSwitch';
import useDocumentTitle from '../../hooks/useDocumentTitle';
import Quickstart from './Quickstart';
import PricingSection from './PricingSection';

const FEATURES = (t: TFunction) => [
  {
    icon: <ThunderboltOutlined />,
    title: t('landing.features.compatible.title'),
    desc: t('landing.features.compatible.desc'),
  },
  {
    icon: <DeploymentUnitOutlined />,
    title: t('landing.features.failover.title'),
    desc: t('landing.features.failover.desc'),
  },
  {
    icon: <ApiOutlined />,
    title: t('landing.features.protocols.title'),
    desc: t('landing.features.protocols.desc'),
  },
  {
    icon: <AccountBookOutlined />,
    title: t('landing.features.metering.title'),
    desc: t('landing.features.metering.desc'),
  },
  {
    icon: <CloudServerOutlined />,
    title: t('landing.features.byok.title'),
    desc: t('landing.features.byok.desc'),
  },
  {
    icon: <SafetyCertificateOutlined />,
    title: t('landing.features.governance.title'),
    desc: t('landing.features.governance.desc'),
  },
];

const NAV_LINKS = (t: TFunction) => [
  { href: '#features', label: t('landing.nav.features') },
  { href: '#quickstart', label: t('landing.nav.quickstart') },
  { href: '#pricing', label: t('landing.nav.pricing') },
];

export default function LandingPage() {
  const { t } = useTranslation();
  const { user } = useAuth();
  const location = useLocation();
  const origin = typeof window === 'undefined' ? '' : window.location.origin;

  useDocumentTitle();

  const statsQuery = useQuery({
    queryKey: ['public', 'stats'],
    queryFn: ({ signal }) => publicApi.stats(signal),
    staleTime: 60_000,
  });

  const modelsQuery = useQuery({
    queryKey: ['public', 'models'],
    queryFn: ({ signal }) => publicApi.models(signal),
    staleTime: 60_000,
  });

  useEffect(() => {
    if (location.hash) {
      const el = document.querySelector(location.hash);
      if (el) {
        el.scrollIntoView({ behavior: 'smooth', block: 'start' });
        return;
      }
    }
    window.scrollTo(0, 0);
  }, [location.hash]);

  const items = modelsQuery.data?.items ?? [];
  const stats = statsQuery.data;
  const sampleModel =
    items.find((m) => m.name === 'gpt-5.6')?.name ?? items[0]?.name ?? 'gpt-5.6';

  const statCards = [
    {
      label: t('landing.stats.models.label'),
      value: statsQuery.isLoading ? '—' : String(stats?.modelCount ?? 0),
      sub: stats?.providerCount
        ? t('landing.stats.models.subWithProviders', { num: stats.providerCount })
        : t('landing.stats.models.subFallback'),
    },
    {
      label: t('landing.stats.channels.label'),
      value: statsQuery.isLoading ? '—' : String(stats?.channelCount ?? 0),
      sub: t('landing.stats.channels.sub'),
    },
    {
      label: t('landing.stats.protocols.label'),
      value: stats ? `${Math.round((stats.protocolCount / 3) * 100)}%` : '100%',
      sub: 'OpenAI · Anthropic · Gemini',
    },
    {
      label: t('landing.stats.billing.label'),
      value: t('landing.stats.billing.value'),
      sub: t('landing.stats.billing.sub'),
    },
  ];

  return (
    <div className="lp">
      <header className="lp-nav">
        <div className="lp-container lp-nav-inner">
          <Link to="/" className="lp-logo">
            <Logo size={24} />
            <span>AI Gateway</span>
          </Link>
          <nav className="lp-nav-links" aria-label={t('landing.nav.ariaLabel')}>
            {NAV_LINKS(t).map((l) => (
              <a key={l.href} href={l.href}>
                {l.label}
              </a>
            ))}
          </nav>
          <div className="lp-nav-actions">
            <LangSwitch />
            {user ? (
              <Link to="/dashboard">
                <Button type="primary">{t('landing.nav.enterConsole')}</Button>
              </Link>
            ) : (
              <>
                <Link to="/login">
                  <Button type="text">{t('landing.nav.signIn')}</Button>
                </Link>
                <Link to="/login">
                  <Button type="primary">{t('landing.nav.signUp')}</Button>
                </Link>
              </>
            )}
          </div>
        </div>
      </header>

      <section className="lp-hero">
        <div className="lp-container">
          <div className="lp-hero-inner">
            <div className="lp-badge">
              <b>New</b>
              {t('landing.hero.badge')}
            </div>
            <h1>
              {t('landing.hero.titleLead')}
              <br />
              <em>{t('landing.hero.titleAccent')}</em>
            </h1>
            <p className="lp-hero-sub">{t('landing.hero.sub')}</p>
            <div className="lp-hero-cta">
              <Link to="/login">
                <Button type="primary" size="large" icon={<ArrowRightOutlined />}>
                  {t('landing.hero.signUp')}
                </Button>
              </Link>
              <a href="#quickstart">
                <Button size="large">{t('landing.hero.viewQuickstart')}</Button>
              </a>
            </div>
            <div className="lp-hero-note">POST {origin}/v1/chat/completions</div>
          </div>
        </div>
      </section>

      <div className="lp-container">
        <div className="lp-stats">
          {statCards.map((s) => (
            <div className="lp-stat" key={s.label}>
              <div className="lp-stat-label">{s.label}</div>
              <div className="lp-stat-value">{s.value}</div>
              <div className="lp-stat-sub">{s.sub}</div>
            </div>
          ))}
        </div>
      </div>

      <section className="lp-section" id="features">
        <div className="lp-container">
          <div className="lp-section-head">
            <div className="lp-eyebrow">{t('landing.section.features.eyebrow')}</div>
            <h2>{t('landing.section.features.title')}</h2>
            <p>{t('landing.section.features.desc')}</p>
          </div>
          <div className="lp-grid">
            {FEATURES(t).map((f) => (
              <div className="lp-card" key={f.title}>
                <div className="lp-card-icon">{f.icon}</div>
                <h3>{f.title}</h3>
                <p>{f.desc}</p>
              </div>
            ))}
          </div>
        </div>
      </section>

      <section className="lp-section" id="quickstart">
        <div className="lp-container">
          <div className="lp-section-head">
            <div className="lp-eyebrow">{t('landing.section.quickstart.eyebrow')}</div>
            <h2>{t('landing.section.quickstart.title')}</h2>
            <p>{t('landing.section.quickstart.desc')}</p>
          </div>
          <Quickstart origin={origin} model={sampleModel} />
        </div>
      </section>

      <section className="lp-section" id="pricing">
        <div className="lp-container">
          <div className="lp-section-head">
            <div className="lp-eyebrow">{t('landing.section.pricing.eyebrow')}</div>
            <h2>{t('landing.section.pricing.title')}</h2>
            <p>{t('landing.section.pricing.desc')}</p>
          </div>
          <PricingSection data={modelsQuery.data} loading={modelsQuery.isLoading} />
        </div>
      </section>

      <section className="lp-section">
        <div className="lp-container">
          <div className="lp-cta">
            <h2>{t('landing.cta.title')}</h2>
            <p>{t('landing.cta.desc')}</p>
            <Link to="/login">
              <Button type="primary" size="large" icon={<ArrowRightOutlined />}>
                {t('landing.cta.button')}
              </Button>
            </Link>
          </div>
        </div>
      </section>

      <footer className="lp-footer">
        <div className="lp-container lp-footer-inner">
          <div className="lp-logo" style={{ color: 'var(--text-2)', fontWeight: 500 }}>
            <Logo size={22} />
            <span>© {new Date().getFullYear()} AI Gateway</span>
          </div>
          <div className="lp-footer-links">
            <a href="#features">{t('landing.nav.features')}</a>
            <a href="#quickstart">{t('landing.nav.quickstart')}</a>
            <a href="#pricing">{t('landing.nav.pricing')}</a>
            <Link to="/login">{t('landing.nav.signIn')}</Link>
          </div>
        </div>
      </footer>
    </div>
  );
}
