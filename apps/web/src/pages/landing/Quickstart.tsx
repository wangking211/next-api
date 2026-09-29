import { useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import type { TFunction } from 'i18next';

type Lang = 'curl' | 'python' | 'node';

const TABS: { key: Lang; label: string }[] = [
  { key: 'curl', label: 'cURL' },
  { key: 'python', label: 'Python' },
  { key: 'node', label: 'Node.js' },
];

function buildSamples(origin: string, model: string, prompt: string) {
  const url = `${origin}/v1/chat/completions`;
  return {
    curl: `curl ${url} \\
  -H "Authorization: Bearer sk-YOUR_KEY" \\
  -H "Content-Type: application/json" \\
  -d '{
    "model": "${model}",
    "messages": [{ "role": "user", "content": "${prompt}" }],
    "stream": true
  }'`,
    python: `from openai import OpenAI

client = OpenAI(
    api_key="sk-YOUR_KEY",
    base_url="${origin}/v1",
)

resp = client.chat.completions.create(
    model="${model}",
    messages=[{"role": "user", "content": "${prompt}"}],
)
print(resp.choices[0].message.content)`,
    node: `import OpenAI from 'openai';

const client = new OpenAI({
  apiKey: 'sk-YOUR_KEY',
  baseURL: '${origin}/v1',
});

const resp = await client.chat.completions.create({
  model: '${model}',
  messages: [{ role: 'user', content: '${prompt}' }],
});
console.log(resp.choices[0].message.content);`,
  };
}

function CopyButton({ code }: { code: string }) {
  const { t } = useTranslation();
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
      {copied ? t('common.copied') : t('common.copy')}
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

const STEPS = (t: TFunction) => [
  {
    title: t('landing.quickstart.steps.register.title'),
    desc: t('landing.quickstart.steps.register.desc'),
    meta: '/login',
  },
  {
    title: t('landing.quickstart.steps.topup.title'),
    desc: t('landing.quickstart.steps.topup.desc'),
    meta: t('landing.quickstart.steps.topup.meta'),
  },
  {
    title: t('landing.quickstart.steps.createKey.title'),
    desc: t('landing.quickstart.steps.createKey.desc'),
    meta: 'sk-••••••••',
  },
  {
    title: t('landing.quickstart.steps.baseUrl.title'),
    desc: t('landing.quickstart.steps.baseUrl.desc'),
    meta: '{origin}/v1',
  },
];

export default function Quickstart({ origin, model }: { origin: string; model: string }) {
  const { t } = useTranslation();
  const [lang, setLang] = useState<Lang>('curl');
  const samplePrompt = t('landing.quickstart.samplePrompt');
  const samples = useMemo(
    () => buildSamples(origin, model, samplePrompt),
    [origin, model, samplePrompt],
  );

  return (
    <>
      <div className="lp-steps">
        {STEPS(t).map((s, i) => (
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
          {TABS.map((tab) => (
            <button
              key={tab.key}
              type="button"
              className="lp-code-tab"
              data-active={lang === tab.key}
              onClick={() => setLang(tab.key)}
            >
              {tab.label}
            </button>
          ))}
          <CopyButton code={samples[lang]} />
        </div>
        <CodeBody code={samples[lang]} />
      </div>
    </>
  );
}
