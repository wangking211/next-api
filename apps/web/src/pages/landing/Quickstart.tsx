import { useMemo, useState } from 'react';

type Lang = 'curl' | 'python' | 'node';

const TABS: { key: Lang; label: string }[] = [
  { key: 'curl', label: 'cURL' },
  { key: 'python', label: 'Python' },
  { key: 'node', label: 'Node.js' },
];

function buildSamples(origin: string, model: string) {
  const url = `${origin}/v1/chat/completions`;
  return {
    curl: `curl ${url} \\
  -H "Authorization: Bearer sk-YOUR_KEY" \\
  -H "Content-Type: application/json" \\
  -d '{
    "model": "${model}",
    "messages": [{ "role": "user", "content": "用一句话介绍你自己" }],
    "stream": true
  }'`,
    python: `from openai import OpenAI

client = OpenAI(
    api_key="sk-YOUR_KEY",
    base_url="${origin}/v1",
)

resp = client.chat.completions.create(
    model="${model}",
    messages=[{"role": "user", "content": "用一句话介绍你自己"}],
)
print(resp.choices[0].message.content)`,
    node: `import OpenAI from 'openai';

const client = new OpenAI({
  apiKey: 'sk-YOUR_KEY',
  baseURL: '${origin}/v1',
});

const resp = await client.chat.completions.create({
  model: '${model}',
  messages: [{ role: 'user', content: '用一句话介绍你自己' }],
});
console.log(resp.choices[0].message.content);`,
  };
}

function CopyButton({ code }: { code: string }) {
  const [copied, setCopied] = useState(false);
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(code);
      setCopied(true);
      setTimeout(() => setCopied(false), 1600);
    } catch {
      /* 剪贴板不可用时静默 */
    }
  };
  return (
    <button type="button" className="lp-code-copy" onClick={copy}>
      {copied ? '已复制' : '复制'}
    </button>
  );
}

function CodeBody({ code }: { code: string }) {
  return (
    <pre>
      {code.split('\n').map((line, i) => (
        <div key={i} className={/^\s*(#|\/\/)/.test(line) ? 'c' : undefined}>
          {line || ' '}
        </div>
      ))}
    </pre>
  );
}

const STEPS = [
  {
    title: '注册并登录',
    desc: '创建账号即可进入控制台，管理员可自助充值或发放兑换码。',
    meta: '/login',
  },
  {
    title: '充值余额',
    desc: '按需充值积分，余额实时入账，账单逐笔可查，支持导出 CSV。',
    meta: '余额与账单',
  },
  {
    title: '创建 API Key',
    desc: 'Key 明文只展示一次，可设置额度、费用上限、RPM 与过期时间。',
    meta: 'sk-••••••••',
  },
  {
    title: '设置 base_url',
    desc: '把现有 SDK 的 base_url 指向网关地址，模型名原样透传即可。',
    meta: '{origin}/v1',
  },
];

export default function Quickstart({ origin, model }: { origin: string; model: string }) {
  const [lang, setLang] = useState<Lang>('curl');
  const samples = useMemo(() => buildSamples(origin, model), [origin, model]);

  return (
    <>
      <div className="lp-steps">
        {STEPS.map((s, i) => (
          <div className="lp-step" key={s.title}>
            <div className="lp-step-num">{i + 1}</div>
            <h3>{s.title}</h3>
            <p>{s.desc}</p>
            <div className="lp-step-meta">{s.meta.replace('{origin}', origin)}</div>
          </div>
        ))}
      </div>

      <div className="lp-code">
        <div className="lp-code-bar">
          {TABS.map((t) => (
            <button
              key={t.key}
              type="button"
              className="lp-code-tab"
              data-active={lang === t.key}
              onClick={() => setLang(t.key)}
            >
              {t.label}
            </button>
          ))}
          <CopyButton code={samples[lang]} />
        </div>
        <CodeBody code={samples[lang]} />
      </div>
    </>
  );
}
