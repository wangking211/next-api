interface LogoProps {
  size?: number;
  /** 深色背景上使用白色标识块 */
  onDark?: boolean;
}

/** 品牌标识：方角圆角块 + 终端提示符，纯内联 SVG（生产 CSP 禁止外链图片） */
export default function Logo({ size = 26, onDark = false }: LogoProps) {
  const bg = onDark ? '#ffffff' : '#1677ff';
  const fg = onDark ? '#0a0f1c' : '#ffffff';
  return (
    <svg width={size} height={size} viewBox="0 0 32 32" fill="none" aria-hidden="true">
      <rect x="0" y="0" width="32" height="32" rx="9" fill={bg} />
      <path
        d="M10 11.5 15.5 16 10 20.5"
        stroke={fg}
        strokeWidth="2.4"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
      <path d="M17.5 20.5H23" stroke={fg} strokeWidth="2.4" strokeLinecap="round" />
    </svg>
  );
}

export function LogoText({ onDark = false }: { onDark?: boolean }) {
  return (
    <>
      <Logo size={24} onDark={onDark} />
      <span>AI Gateway</span>
    </>
  );
}
