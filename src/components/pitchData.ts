import type { TeamWeekResult } from "@/lib/scoring/team";
import type { PickView } from "@/lib/services/views";
import type { PitchPlayer } from "./Pitch";

/** Places a locked team on the pitch as it actually scored: substitutes on, non-players on the bench. */
export function pitchFromResult(picks: PickView[], detail: TeamWeekResult | undefined, doubles: Set<number> = new Set()): PitchPlayer[] {
  const info = new Map(detail?.players.map((p) => [p.playerId, p]) ?? []);
  const counted = (p: PickView) => info.get(p.player_id)?.counted ?? p.slot <= 11;
  const xi = picks.filter(counted);
  const bench = picks.filter((p) => !counted(p)).sort((a, b) => a.slot - b.slot);
  const benchGk = bench.filter((p) => p.position === "GK");
  const slotOf = new Map<number, number>();
  xi.forEach((p, i) => slotOf.set(p.player_id, i + 1));
  if (benchGk.length === 1) {
    slotOf.set(benchGk[0].player_id, 12);
    bench.filter((p) => p.position !== "GK").forEach((p, i) => slotOf.set(p.player_id, 13 + i));
  } else bench.forEach((p, i) => slotOf.set(p.player_id, 12 + i));
  return picks.map((p) => {
    const i = info.get(p.player_id);
    return {
      id: p.player_id,
      name: p.name,
      position: p.position,
      kit: p.kit,
      slot: slotOf.get(p.player_id)!,
      stat: String(i ? i.points * Math.max(1, i.multiplier) : 0),
      statIsScore: counted(p),
      captain: i?.multiplier === 2,
      vice: p.is_vice && i?.multiplier !== 2,
      dim: !!i && i.resolved && !i.played,
      note: i?.subbedIn ? "IN" : doubles.has(p.player_id) ? "x2" : undefined,
    };
  });
}
