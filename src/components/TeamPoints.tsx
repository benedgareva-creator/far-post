import { picksFor, playerWeekPoints } from "@/lib/services/views";
import type { TeamWeekResult } from "@/lib/scoring/team";
import { StatusPill } from "./StatusPill";
import { Pitch } from "./Pitch";
import { pitchFromResult } from "./pitchData";
import { Shirt } from "./Shirt";

const ORDER = ["GK", "DEF", "MID", "FWD"];

export async function TeamPoints({ userId, week, result, teamName }: { userId: number; week: number; result: { points: number; status: string; detail: unknown } | null; teamName?: string | null }) {
  const picks = await picksFor(userId, week);
  const detail = result?.detail as TeamWeekResult | undefined;
  const pts = await playerWeekPoints(week, picks.map((p) => p.player_id));
  const info = new Map(detail?.players.map((p) => [p.playerId, p]) ?? []);
  const counted = (id: number, slot: number) => info.get(id)?.counted ?? slot <= 11;
  const shown = (id: number) => {
    const i = info.get(id);
    return i ? i.points * Math.max(1, i.multiplier) : 0;
  };
  const xiNow = picks.filter((p) => counted(p.player_id, p.slot));
  const benchOrder = picks.filter((p) => !counted(p.player_id, p.slot)).sort((a, b) => a.slot - b.slot);
  const best = [...xiNow].sort((a, b) => shown(b.player_id) - shown(a.player_id))[0];

  const line = (p: (typeof picks)[number]) => {
    const i = info.get(p.player_id);
    const games = pts.get(p.player_id) ?? [];
    const breakdown = games.flatMap((g) => g.breakdown).map((b) => `${b.label} ${b.points > 0 ? "+" : ""}${b.points}`).join(" · ");
    const pending = games.some((g) => g.pending.length > 0);
    return (
      <div className={`row${i && !i.counted ? " dim" : ""}`} key={p.player_id}>
        <span className="mini-shirt"><Shirt kit={p.kit} keeper={p.position === "GK"} size={34} /></span>
        <div className="grow">
          <div className="title">
            {p.name} {i?.multiplier === 2 && <span className="badge">C</span>} {p.is_vice && i?.multiplier !== 2 && <span className="badge v">V</span>}
          </div>
          <div className="meta">
            {p.position} · {p.club_short}
            {games.length > 1 ? ` · ${games.length} matches` : ""}
            {i?.subbedIn ? " · came off the bench" : ""}
            {i?.subbedOut ? " · replaced (did not play)" : ""}
            {breakdown ? ` · ${breakdown}` : i && !i.played && i.resolved ? " · did not play" : ""}
            {pending ? " · pending numbers" : ""}
          </div>
        </div>
        <div className="pts">{shown(p.player_id)}</div>
      </div>
    );
  };
  return (
    <>
      <section className="hero">
        <div className="hero-top"><span className="hero-week">{teamName ? `${teamName} · ` : ""}Week {week}</span>{result && <StatusPill status={result.status} partial={detail?.partial} />}</div>
        <div className="hero-score">{result?.points ?? 0}</div>
        {best && shown(best.player_id) > 0 && <div className="small">Top scorer: {best.name} ({shown(best.player_id)})</div>}
        {detail?.notes.map((n) => <div key={n} className="small">{n}</div>)}
      </section>
      <Pitch players={pitchFromResult(picks, detail, new Set(picks.filter((p) => (pts.get(p.player_id)?.length ?? 0) > 1).map((p) => p.player_id)))} />
      <h2>Points breakdown</h2>
      <div className="list">{[...xiNow].sort((a, b) => ORDER.indexOf(a.position) - ORDER.indexOf(b.position)).map(line)}</div>
      <h2>Bench</h2>
      <div className="list">{benchOrder.map(line)}</div>
    </>
  );
}
