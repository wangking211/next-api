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
import { useAuth } from '../../auth/AuthContext';
import { publicApi } from '../../api/endpoints';
import Logo from '../../components/Logo';
import useDocumentTitle from '../../hooks/useDocumentTitle';
import Quickstart from './Quickstart';
import PricingSection from './PricingSection';

const FEATURES = [
  {
    icon: <ThunderboltOutlined />,
    title: 'OpenAI 兼容接口',
    desc: '一行 base_url 替换即可接入现有 SDK，/v1/chat/completions 与 /v1/models 开箱可用，流式 SSE 原生支持。',
  },
  {
    icon: <DeploymentUnitOutlined />,
    title: '多渠道自动故障转移',
    desc: '上游 5xx / 429 自动切换下一渠道，按优先级与权重路由；连续失败达到阈值自动禁用并推送告警。',
  },
  {
    icon: <ApiOutlined />,
    title: '三协议双向适配',
    desc: 'OpenAI、Anthropic、Gemini 原生协议互转，请求与响应双向转换，图片输入与流式增量均正确透传。',
  },
  {
    icon: <AccountBookOutlined />,
    title: '按 Token 精确计量',
    desc: '输入、输出、缓存读、缓存写四列独立计价，逐请求落账，支持按模型 / 渠道 / 用户聚合与 CSV 导出。',
  },
  {
    icon: <CloudServerOutlined />,
    title: 'BYOK 自带渠道',
    desc: '用自己的上游 Key 建渠道，路由优先级高于平台渠道，调用不消耗平台余额，密钥全程 AES-256-GCM 加密。',
  },
  {
    icon: <SafetyCertificateOutlined />,
    title: '密钥与权限治理',
    desc: 'API Key 明文仅展示一次、SHA-256 存储，可限制额度 / 费用 / RPM / 过期时间，操作全程审计留痕。',
  },
];

const NAV_LINKS = [
  { href: '#features', label: '能力' },
  { href: '#quickstart', label: '快速上手' },
  { href: '#pricing', label: '模型定价' },
];

export default function LandingPage() {
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
      label: '接入模型',
      value: statsQuery.isLoading ? '—' : String(stats?.modelCount ?? 0),
      sub: stats?.providerCount ? `覆盖 ${stats.providerCount} 家提供商` : '多厂商模型目录',
    },
    {
      label: '上游渠道',
      value: statsQuery.isLoading ? '—' : String(stats?.channelCount ?? 0),
      sub: '启用中的平台渠道',
    },
    {
      label: '协议支持',
      value: stats ? `${Math.round((stats.protocolCount / 3) * 100)}%` : '100%',
      sub: 'OpenAI · Anthropic · Gemini',
    },
    {
      label: '计费粒度',
      value: 'Token 级',
      sub: '输入 / 输出 / 缓存读写分列',
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
          <nav className="lp-nav-links" aria-label="页面导航">
            {NAV_LINKS.map((l) => (
              <a key={l.href} href={l.href}>
                {l.label}
              </a>
            ))}
          </nav>
          <div className="lp-nav-actions">
            {user ? (
              <Link to="/dashboard">
                <Button type="primary">进入控制台</Button>
              </Link>
            ) : (
              <>
                <Link to="/login">
                  <Button type="text">登录</Button>
                </Link>
                <Link to="/login">
                  <Button type="primary">免费注册</Button>
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
              支持缓存读写计价、自动故障转移与代理返点
            </div>
            <h1>
              一个 API，
              <br />
              <em>接入全部主流大模型</em>
            </h1>
            <p className="lp-hero-sub">
              OpenAI 兼容协议，聚合多家上游服务商，按 token
              精确计量与结算。渠道故障自动切换，密钥与额度统一治理——把路由、计费和运营的复杂度全部交给网关。
            </p>
            <div className="lp-hero-cta">
              <Link to="/login">
                <Button type="primary" size="large" icon={<ArrowRightOutlined />}>
                  免费注册
                </Button>
              </Link>
              <a href="#quickstart">
                <Button size="large">查看快速上手</Button>
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
            <div className="lp-eyebrow">能力</div>
            <h2>网关该做的事，一件不落</h2>
            <p>从路由到计费再到审计，覆盖多模型接入的完整链路，不需要再拼装一堆脚本。</p>
          </div>
          <div className="lp-grid">
            {FEATURES.map((f) => (
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
            <div className="lp-eyebrow">快速上手</div>
            <h2>四步发出第一次请求</h2>
            <p>已有 SDK 不用改代码，只换 base_url 和模型名。</p>
          </div>
          <Quickstart origin={origin} model={sampleModel} />
        </div>
      </section>

      <section className="lp-section" id="pricing">
        <div className="lp-container">
          <div className="lp-section-head">
            <div className="lp-eyebrow">模型定价</div>
            <h2>按 token 结算，价格透明</h2>
            <p>下表为当前网关启用中的模型目录，与控制台「模型」页实时同步。</p>
          </div>
          <PricingSection data={modelsQuery.data} loading={modelsQuery.isLoading} />
        </div>
      </section>

      <section className="lp-section">
        <div className="lp-container">
          <div className="lp-cta">
            <h2>准备好接入了吗？</h2>
            <p>注册即用，创建 Key 后一分钟内发出第一条请求。无需商务对接。</p>
            <Link to="/login">
              <Button type="primary" size="large" icon={<ArrowRightOutlined />}>
                立即开始
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
            <a href="#features">能力</a>
            <a href="#quickstart">快速上手</a>
            <a href="#pricing">模型定价</a>
            <Link to="/login">登录</Link>
          </div>
        </div>
      </footer>
    </div>
  );
}
