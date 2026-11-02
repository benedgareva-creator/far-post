import { picksFor, playerWeekPoints } from "@/lib/services/views";
import type { TeamWeekResult } from "@/lib/scoring/team";
import { StatusPill } from "./StatusPill";

const ORDER = ["GK", "DEF", "MID", "FWD"];

export async function TeamPoints({ userId, week, result }: { userId: number; week: number; result: { points: number; status: string; detail: unknown } | null }) {
  const picks = await picksFor(userId, week);
  const detail = result?.detail as TeamWeekResult | undefined;
  const pts = await playerWeekPoints(week, picks.map((p) => p.player_id));
  const info = new Map(detail?.players.map((p) => [p.playerId, p]) ?? []);
  const counted = picks.filter((p) => info.get(p.player_id)?.counted ?? p.slot <= 11);
  const bench = picks.filter((p) => !(info.get(p.player_id)?.counted ?? p.slot <= 11));
  const sorted = counted.sort((a, b) => ORDER.indexOf(a.position) - ORDER.indexOf(b.position));
  const line = (p: (typeof picks)[number]) => {
    const i = info.get(p.player_id);
    const games = pts.get(p.player_id) ?? [];
    const breakdown = games.flatMap((g) => g.breakdown).map((b) => `${b.label} ${b.points > 0 ? "+" : ""}${b.points}`).join(" · ");
    const pending = games.some((g) => g.pending.length > 0);
    return (
      <div className={`row${i && !i.counted ? " dim" : ""}`} key={p.player_id}>
        <span className="pos">{p.position}</span>
        <div className="grow">
          <div className="title">
            {p.name} {i?.multiplier === 2 && <span className="badge">C</span>} {p.is_vice && i?.multiplier !== 2 && <span className="badge v">V</span>}
          </div>
          <div className="meta">
            {p.club_short}
            {games.length > 1 ? ` · ${games.length} matches` : ""}
            {i?.subbedIn ? " · came off the bench" : ""}
            {i?.subbedOut ? " · replaced (did not play)" : ""}
            {breakdown ? ` · ${breakdown}` : i && !i.played && i.resolved ? " · did not play" : ""}
            {pending ? " · pending numbers" : ""}
          </div>
        </div>
        <div className="pts">{i ? i.points * Math.max(1, i.multiplier) : 0}</div>
      </div>
    );
  };
  return (
    <>
      <section className="hero">
        <div className="hero-top"><span style={{ fontWeight: 700 }}>Week {week}</span>{result && <StatusPill status={result.status} partial={detail?.partial} />}</div>
        <div className="hero-score">{result?.points ?? 0}</div>
        {detail?.notes.map((n) => <div key={n} className="small">{n}</div>)}
      </section>
      <h2>Playing</h2>
      <div className="list">{sorted.map(line)}</div>
      <h2>Bench</h2>
      <div className="list">{bench.sort((a, b) => a.slot - b.slot).map(line)}</div>
    </>
  );
}
