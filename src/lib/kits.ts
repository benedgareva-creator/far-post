// Far Post's own shirt designs. Every club gets an invented colour scheme and pattern
// from this palette (never the club's real kit), so the pitch view needs no licensed assets.

export type Pattern = "solid" | "stripes" | "hoops" | "halves" | "sash" | "sleeves" | "chevron" | "pinstripe";
export interface Kit {
  base: string;
  accent: string;
  trim: string;
  pattern: Pattern;
}

const PALETTE = [
  "#E63946", "#F4A261", "#E9C46A", "#2A9D8F", "#264653", "#1D4ED8", "#0EA5E9", "#7C3AED",
  "#DB2777", "#16A34A", "#84CC16", "#F97316", "#0F172A", "#F8FAFC", "#B91C1C", "#14B8A6",
  "#FACC15", "#4338CA", "#9F1239", "#065F46",
];
const PATTERNS: Pattern[] = ["solid", "stripes", "hoops", "halves", "sash", "sleeves", "chevron", "pinstripe"];

function hash(s: string): number {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) h = Math.imul(h ^ s.charCodeAt(i), 16777619);
  return h >>> 0;
}

function luminance(hex: string): number {
  const n = parseInt(hex.slice(1), 16);
  const [r, g, b] = [(n >> 16) & 255, (n >> 8) & 255, n & 255].map((v) => {
    const c = v / 255;
    return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
  });
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

const contrast = (a: string, b: string) => {
  const [x, y] = [luminance(a), luminance(b)].sort((p, q) => q - p);
  return (x + 0.05) / (y + 0.05);
};

/** A stable, invented kit for a club id. Base and accent always contrast. */
export function kitFor(clubKey: string): Kit {
  const h = hash(`kit:${clubKey}`);
  const base = PALETTE[h % PALETTE.length];
  const h2 = hash(`accent:${clubKey}:x`);
  let accent = PALETTE[h2 % PALETTE.length];
  for (let i = 0; contrast(base, accent) < 2.2 && i < PALETTE.length; i++) accent = PALETTE[(h2 + i + 1) % PALETTE.length];
  const pattern = PATTERNS[hash(`pattern:${clubKey}:y`) % PATTERNS.length];
  const trim = luminance(base) > 0.5 ? "#0F172A" : "#F8FAFC";
  return { base, accent, trim, pattern };
}

/** Text colour that reads on the kit's base colour. */
export function inkOn(hex: string): string {
  return luminance(hex) > 0.45 ? "#0F172A" : "#FFFFFF";
}
