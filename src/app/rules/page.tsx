import { requireUser } from "@/lib/auth";
import { now as gameNow } from "@/lib/clock";
import { q } from "@/lib/db";
import { POSITIONS, type Position } from "@/lib/game/rules";
import { MEASURE_LABELS, parseRules, type MeasureKey, type ScoringRules } from "@/lib/scoring/rules";
import { rulesForWeek } from "@/lib/services/scoring";
import { currentWeek, upcomingWeek } from "@/lib/services/teams";

export const dynamic = "force-dynamic";

const POS: Position[] = POSITIONS;
const sign = (n: number) => (n > 0 ? `+${n}` : String(n));

/** One row per measure: what earns it, and the points for each position (– where it does not apply). */
function rows(r: ScoringRules) {
  const out: { label: string; note: string; points: (string | null)[] }[] = [];
  const keys = Object.keys(MEASURE_LABELS) as MeasureKey[];
  for (const k of keys) {
    const m = r[k];
    if (!m.enabled) continue;
    if (k === "minutes") {
      const mm = r.minutes;
      out.push({ label: "Playing up to " + (mm.threshold - 1) + " minutes", note: "", points: POS.map((p) => (mm.eligible.includes(p) ? sign(mm.shortPoints) : null)) });
      out.push({ label: `Playing ${mm.threshold} minutes or more`, note: "", points: POS.map((p) => (mm.eligible.includes(p) ? sign(mm.longPoints) : null)) });
      continue;
    }
    const pts = (m as { points: Record<Position, number> }).points;
    let note = "";
    if (k === "cleanSheet") note = `No goals conceded while on for ${r.cleanSheet.minMinutes}+ minutes`;
    if (k === "conceded") note = `For every ${r.conceded.per} goals the team concedes (${r.conceded.minMinutes}+ minutes played)`;
    if (k === "saves") note = `For every ${r.saves.per} saves`;
    if (k === "red" && r.red.replacesYellow) note = "Replaces any yellow card points";
    out.push({ label: MEASURE_LABELS[k], note, points: POS.map((p) => (m.eligible.includes(p) && pts[p] !== 0 ? sign(pts[p]) : null)) });
  }
  return out;
}

function RulesTable({ rules }: { rules: ScoringRules }) {
  return (
    <div className="card scroll-x">
      <table className="table">
        <thead><tr><th></th>{POS.map((p) => <th key={p} className="num">{p}</th>)}</tr></thead>
        <tbody>
          {rows(rules).map((r) => (
            <tr key={r.label}>
              <td><div>{r.label}</div>{r.note && <div className="small">{r.note}</div>}</td>
              {r.points.map((v, i) => <td key={i} className="num">{v ?? "–"}</td>)}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

export default async function Rules() {
  await requireUser();
  const now = await gameNow();
  const next = await upcomingWeek(now);
  const cur = await currentWeek(now);
  const nextRules = next ? await rulesForWeek(next.number) : null;
  const curRules = cur ? await rulesForWeek(cur.number) : null;
  const later = next
    ? await q<{ id: number; name: string; from_week: number; config: unknown }>(
        "SELECT id, name, from_week, config FROM rulesets WHERE status = 'published' AND from_week > $1 ORDER BY from_week, id",
        [next.number],
      )
    : [];
  return (
    <>
      <h1>How points are scored</h1>
      <p className="small">Your captain scores double. If your captain does not play at all, your vice-captain scores double instead. Starters who do not play are replaced from your bench, in your bench order, as long as the formation stays valid.</p>
      {curRules && cur && curRules.id !== nextRules?.id && (
        <>
          <h2>Week {cur.number} (being played now)</h2>
          <RulesTable rules={curRules.rules} />
        </>
      )}
      {nextRules && next && (
        <>
          <h2>Week {next.number}{curRules?.id === nextRules.id && cur ? ` (and Week ${cur.number}, being played now)` : ""}</h2>
          <RulesTable rules={nextRules.rules} />
        </>
      )}
      {later.map((r) => (
        <div key={r.id}>
          <h2>Changes from Week {r.from_week}</h2>
          <div className="notice warn">These rules start at Week {r.from_week}. Weeks before that keep the rules above.</div>
          <RulesTable rules={parseRules(r.config)} />
        </div>
      ))}
    </>
  );
}
