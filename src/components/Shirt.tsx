import type { Kit } from "@/lib/kits";

// Goalkeepers wear a bright shirt chosen to stand apart from the outfield colours.
const KEEPER = ["#C8FF2E", "#2BB3F0", "#FF4D6D", "#FFB020", "#7C5CFF"];
function keeperKit(kit: Kit): Kit {
  const n = parseInt(kit.base.slice(1), 16) + parseInt(kit.accent.slice(1), 16);
  let base = KEEPER[n % KEEPER.length];
  if (base.toLowerCase() === kit.base.toLowerCase()) base = KEEPER[(n + 1) % KEEPER.length];
  return { base, accent: "#0A0F1F", trim: "#0A0F1F", pattern: "sleeves" };
}

const BODY = "M21 7 L11 11 L2 21 L9 31 L15 27 L15 60 L49 60 L49 27 L55 31 L62 21 L53 11 L43 7 Q38 14 32 14 Q26 14 21 7 Z";
const LEFT_SLEEVE = "M21 7 L11 11 L2 21 L9 31 L15 27 L17 12 Z";
const RIGHT_SLEEVE = "M43 7 L53 11 L62 21 L55 31 L49 27 L47 12 Z";

function patternShapes(k: Kit) {
  const a = k.accent;
  switch (k.pattern) {
    case "stripes":
      return [19, 29, 39].map((x) => <rect key={x} x={x} y={0} width={6} height={64} fill={a} />);
    case "pinstripe":
      return [20, 26, 32, 38, 44].map((x) => <rect key={x} x={x} y={0} width={1.6} height={64} fill={a} />);
    case "hoops":
      return [20, 33, 46].map((y) => <rect key={y} x={0} y={y} width={64} height={7} fill={a} />);
    case "halves":
      return <rect x={32} y={0} width={32} height={64} fill={a} />;
    case "sash":
      return <polygon points="12,6 24,6 56,60 44,60" fill={a} />;
    case "sleeves":
      return (
        <>
          <path d={LEFT_SLEEVE} fill={a} />
          <path d={RIGHT_SLEEVE} fill={a} />
        </>
      );
    case "chevron":
      return <polygon points="10,22 32,38 54,22 54,31 32,47 10,31" fill={a} />;
    default:
      return <rect x={0} y={52} width={64} height={8} fill={a} />;
  }
}

/** One of Far Post's own shirt designs. Goalkeepers get a plain contrasting shirt. */
export function Shirt({ kit, keeper = false, size = 52, dim = false }: { kit: Kit; keeper?: boolean; size?: number; dim?: boolean }) {
  const k: Kit = keeper ? keeperKit(kit) : kit;
  const id = `s-${k.pattern}-${k.base.slice(1)}-${k.accent.slice(1)}-${keeper ? "g" : "o"}`;
  return (
    <svg viewBox="0 0 64 64" width={size} height={size} aria-hidden style={{ opacity: dim ? 0.45 : 1, filter: "drop-shadow(0 6px 8px rgba(0,0,0,0.35))", overflow: "visible" }}>
      <defs>
        <clipPath id={id}><path d={BODY} /></clipPath>
        <linearGradient id={`${id}-sh`} x1="0" y1="0" x2="1" y2="1">
          <stop offset="0" stopColor="#fff" stopOpacity="0.28" />
          <stop offset="0.5" stopColor="#fff" stopOpacity="0" />
          <stop offset="1" stopColor="#000" stopOpacity="0.22" />
        </linearGradient>
      </defs>
      <g clipPath={`url(#${id})`}>
        <rect width="64" height="64" fill={k.base} />
        {keeper ? <><path d={LEFT_SLEEVE} fill="rgba(10,15,31,0.35)" /><path d={RIGHT_SLEEVE} fill="rgba(10,15,31,0.35)" /></> : patternShapes(k)}
        <rect width="64" height="64" fill={`url(#${id}-sh)`} />
      </g>
      <path d={BODY} fill="none" stroke="rgba(0,0,0,0.35)" strokeWidth="1" />
      <path d="M21 7 Q26 14 32 14 Q38 14 43 7" fill="none" stroke={k.trim} strokeWidth="2.6" strokeLinecap="round" />
    </svg>
  );
}
