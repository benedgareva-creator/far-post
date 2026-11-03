import { redirect } from "next/navigation";
import { requireAdmin } from "@/lib/auth";
import { q } from "@/lib/db";
import { decideCorrection, requestRefetch, waitingCorrections } from "@/lib/services/admin";
import { AdminNav } from "@/components/AdminNav";
import { fmtDate } from "@/components/StatusPill";

export const dynamic = "force-dynamic";

async function decide(formData: FormData) {
  "use server";
  const admin = await requireAdmin();
  await decideCorrection(admin.id, Number(formData.get("id")), formData.get("approve") === "1");
  redirect("/admin/corrections");
}

async function refetch(formData: FormData) {
  "use server";
  const admin = await requireAdmin();
  await requestRefetch(admin.id, Number(formData.get("fixture")));
  redirect("/admin/corrections?m=" + encodeURIComponent("Asked for. The poller fetches it within a minute; any change will appear here."));
}

const FIELDS: [string, string][] = [["minutes", "Min"], ["goals", "G"], ["assists", "A"], ["saves", "Sv"], ["yellow", "Y"], ["red", "R"], ["own_goals", "OG"], ["pen_saved", "PS"], ["pen_missed", "PM"]];

export default async function Corrections({ searchParams }: { searchParams: Promise<{ m?: string }> }) {
  await requireAdmin();
  const { m } = await searchParams;
  const waiting = await waitingCorrections();
  const decided = await q<{ id: number; name: string; status: string; decided_at: Date }>(
    `SELECT c.id, COALESCE(p.name, hc.short_name || ' v ' || ac.short_name || ' score') AS name, c.status, c.decided_at
       FROM corrections c JOIN fixtures f ON f.id = c.fixture_id JOIN clubs hc ON hc.id = f.home_club_id JOIN clubs ac ON ac.id = f.away_club_id
       LEFT JOIN players p ON p.id = c.player_id
      WHERE c.status <> 'waiting' ORDER BY c.decided_at DESC LIMIT 20`,
  );
  const recent = await q<{ id: number; label: string; finished_at: Date; refetch_requested: boolean; data_complete: boolean }>(
    `SELECT f.id, hc.short_name || ' ' || COALESCE(f.home_goals::text, '-') || '–' || COALESCE(f.away_goals::text, '-') || ' ' || ac.short_name || ' (Week ' || f.week_number || ')' AS label,
            f.finished_at, f.refetch_requested, f.data_complete
       FROM fixtures f JOIN clubs hc ON hc.id = f.home_club_id JOIN clubs ac ON ac.id = f.away_club_id
      WHERE f.finished_at IS NOT NULL AND f.week_number IS NOT NULL ORDER BY f.finished_at DESC LIMIT 40`,
  );
  return (
    <>
      <AdminNav active="/admin/corrections" />
      <p className="small">Points become final 72 hours after full time. If the supplier changes a final number later, it waits here. Approving rescores with that Week's original rules and locked teams, and updates league totals.</p>
      {m && <div className="notice ok">{m}</div>}
      {waiting.length === 0 && <div className="empty">Nothing waiting.</div>}
      <div className="stack">
        {waiting.map((c) => c.kind === "score" ? (
          <div className="card" key={c.id}>
            <div className="spread"><strong>{c.match}: final score changed</strong><span className="small">Week {c.week_number}</span></div>
            <p className="small">Was {c.old_stats.home_goals}–{c.old_stats.away_goals}, now {c.new_stats.home_goals}–{c.new_stats.away_goals}. This changes clean sheets and goals conceded.</p>
            {c.affected.length === 0 ? <p className="small">No player's points change.</p> : (
              <div className="list">{c.affected.map((a) => <div className="row" key={a.name}><div className="grow">{a.name}</div><span className="num">{a.oldPoints} → {a.newPoints}</span></div>)}</div>
            )}
            <form action={decide} className="grid2 mt">
              <input type="hidden" name="id" value={c.id} />
              <button className="btn secondary" name="approve" value="0">Reject</button>
              <button className="btn" name="approve" value="1">Approve</button>
            </form>
          </div>
        ) : (
          <div className="card" key={c.id}>
            <div className="spread"><strong>{c.name}</strong><span className="small">{c.match} · Week {c.week_number}</span></div>
            <div className="scroll-x">
              <table className="table">
                <thead><tr><th></th>{FIELDS.map(([, l]) => <th key={l}>{l}</th>)}<th>Pts</th></tr></thead>
                <tbody>
                  <tr><td className="small">Was</td>{FIELDS.map(([k]) => <td key={k} className="num">{c.old_stats[k] ?? "–"}</td>)}<td className="num">{c.oldPoints}</td></tr>
                  <tr><td className="small">Now</td>{FIELDS.map(([k]) => <td key={k} className="num" style={c.old_stats[k] !== c.new_stats[k] ? { color: "var(--accent)" } : undefined}>{c.new_stats[k] ?? "–"}</td>)}<td className="num">{c.newPoints}</td></tr>
                </tbody>
              </table>
            </div>
            <form action={decide} className="grid2 mt">
              <input type="hidden" name="id" value={c.id} />
              <button className="btn secondary" name="approve" value="0">Reject</button>
              <button className="btn" name="approve" value="1">Approve</button>
            </form>
          </div>
        ))}
      </div>
      <h2>Fetch a match again</h2>
      <div className="card">
        <p className="small">Matches are checked 30 minutes, 24 hours, 72 hours and 7 days after full time. If you hear of a later change, fetch the match again here.</p>
        <form action={refetch} className="mt">
          <select name="fixture" aria-label="Match" required>
            {recent.map((f) => <option key={f.id} value={f.id}>{f.label}{f.refetch_requested ? " · asked" : ""}{!f.data_complete ? " · incomplete" : ""}</option>)}
          </select>
          <button className="btn block mt" type="submit">Fetch again</button>
        </form>
      </div>
      {decided.length > 0 && (
        <>
          <h2>Recently decided</h2>
          <div className="list">{decided.map((d) => <div className="row" key={d.id}><div className="grow">{d.name}</div><span className="small">{d.status} · {fmtDate(d.decided_at)}</span></div>)}</div>
        </>
      )}
    </>
  );
}
