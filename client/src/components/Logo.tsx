/** OdinAi mark: the yellow ring (the "O" of Odin, as in Odin LINK) with a four-point spark for AI. */
export function LogoMark({ size = 34 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 64 64" aria-hidden="true" className="logomark">
      <rect width="64" height="64" rx="14" fill="#103d6b" />
      <circle cx="30" cy="34" r="15" fill="none" stroke="#ffd617" strokeWidth="7" />
      <path d="M48 8 L51 17 L60 20 L51 23 L48 32 L45 23 L36 20 L45 17 Z" fill="#ffffff" />
    </svg>
  );
}

export function Logo({ size = 34 }: { size?: number }) {
  return (
    <span className="logo">
      <LogoMark size={size} />
      <span className="wordmark"><span className="w1">Odin</span><span className="w2">Ai</span></span>
    </span>
  );
}
