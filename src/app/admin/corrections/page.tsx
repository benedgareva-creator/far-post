import { redirect } from "next/navigation";
import { requireAdmin } from "@/lib/auth";
import { q } from "@/lib/db";
import { decideCorrection, waitingCorrections } from "@/lib/services/admin";
import { AdminNav } from "@/components/AdminNav";
import { fmtDate } from "@/components/StatusPill";

export const dynamic = "force-dynamic";

async function decide(formData: FormData) {
  "use server";
  const admin = await requireAdmin();
  await decideCorrection(admin.id, Number(formData.get("id")), formData.get("approve") === "1");
  redirect("/admin/corrections");
}

const FIELDS: [string, string][] = [["minutes", "Min"], ["goals", "G"], ["assists", "A"], ["saves", "Sv"], ["yellow", "Y"], ["red", "R"], ["own_goals", "OG"], ["pen_saved", "PS"], ["pen_missed", "PM"]];

export default async function Corrections() {
  await requireAdmin();
  const waiting = await waitingCorrections();
  const decided = await q<{ id: number; name: string; status: string; decided_at: Date }>(
    "SELECT c.id, p.name, c.status, c.decided_at FROM corrections c JOIN players p ON p.id = c.player_id WHERE c.status <> 'waiting' ORDER BY c.decided_at DESC LIMIT 20",
  );
  return (
    <>
      <AdminNav active="/admin/corrections" />
      <p className="small">Points become final 72 hours after full time. If the supplier changes a final number later, it waits here. Approving rescores with that Week's original rules and locked teams, and updates league totals.</p>
      {waiting.length === 0 && <div className="empty">Nothing waiting.</div>}
      <div className="stack">
        {waiting.map((c) => (
          <div className="card" key={c.id}>
            <div className="spread"><strong>{c.name}</strong><span className="small">Week {c.week_number}</span></div>
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
      {decided.length > 0 && (
        <>
          <h2>Recently decided</h2>
          <div className="list">{decided.map((d) => <div className="row" key={d.id}><div className="grow">{d.name}</div><span className="small">{d.status} · {fmtDate(d.decided_at)}</span></div>)}</div>
        </>
      )}
    </>
  );
}
