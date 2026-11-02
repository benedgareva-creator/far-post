// Suggested prices (spec section 2). Ben reviews and publishes; prices then stay fixed.
import type { Position } from "./rules";

export interface PricingInput {
  id: number;
  position: Position;
  goals: number | null;
  assists: number | null;
  minutes: number | null;
}

export interface PriceSuggestion {
  id: number;
  price: 4 | 6 | 8 | 10;
  score: number | null;
  note: string;
}

/** Goal points used in the price formula; matches the default scoring rules. */
export type GoalPoints = Record<Position, number>;

/** A record is unreliable when any of the three numbers is missing or impossible. */
function reliable(p: PricingInput): boolean {
  return [p.goals, p.assists, p.minutes].every((v) => typeof v === "number" && Number.isFinite(v) && v >= 0);
}

export function priceScore(p: PricingInput, goalPoints: GoalPoints): number {
  return goalPoints[p.position] * (p.goals ?? 0) + 4 * (p.assists ?? 0) + (p.minutes ?? 0) / 90;
}

/**
 * Rank within each position: top 5% cost 10, next 15% cost 8, next 30% cost 6, rest 4.
 * Ties are broken by player id (lower id ranks higher). Unreliable records default to 6.
 * Band sizes use floor of the cumulative share so small groups are not over-priced.
 */
export function suggestPrices(players: PricingInput[], goalPoints: GoalPoints): PriceSuggestion[] {
  const out: PriceSuggestion[] = [];
  const positions: Position[] = ["GK", "DEF", "MID", "FWD"];
  for (const pos of positions) {
    const group = players.filter((p) => p.position === pos);
    const good = group.filter(reliable);
    for (const p of group.filter((x) => !reliable(x))) {
      out.push({ id: p.id, price: 6, score: null, note: "Missing or unreliable season record: defaulted to 6" });
    }
    const ranked = good
      .map((p) => ({ p, score: priceScore(p, goalPoints) }))
      .sort((a, b) => b.score - a.score || a.p.id - b.p.id);
    const n = ranked.length;
    const cut10 = Math.floor(n * 0.05);
    const cut8 = Math.floor(n * 0.2);
    const cut6 = Math.floor(n * 0.5);
    ranked.forEach(({ p, score }, i) => {
      const price = i < cut10 ? 10 : i < cut8 ? 8 : i < cut6 ? 6 : 4;
      out.push({ id: p.id, price, score: Math.round(score * 100) / 100, note: `Rank ${i + 1} of ${n} ${pos}` });
    });
  }
  return out.sort((a, b) => a.id - b.id);
}
