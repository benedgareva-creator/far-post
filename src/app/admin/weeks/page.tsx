import { requireAdmin } from "@/lib/auth";
import { q } from "@/lib/db";
import { AdminNav } from "@/components/AdminNav";
import { fmtDate } from "@/components/StatusPill";

export const dynamic = "force-dynamic";

export default async function Weeks() {
  await requireAdmin();
  const weeks = await q<{ number: number; deadline: Date; frozen: boolean; locked: boolean; status: string; matches: string; finished: string; teams: string; rules: string | null }>(
    `SELECT w.number, w.deadline, w.frozen, w.locked, w.status,
            (SELECT count(*) FROM fixtures f WHERE f.week_number = w.number) AS matches,
            (SELECT count(*) FROM fixtures f WHERE f.week_number = w.number AND f.status IN ('FT','AET','PEN')) AS finished,
            (SELECT count(DISTINCT user_id) FROM picks k WHERE k.week_number = w.number) AS teams,
            (SELECT name FROM rulesets r WHERE r.id = w.ruleset_id) AS rules
       FROM weeks w ORDER BY w.number`,
  );
  return (
    <>
      <AdminNav active="/admin/weeks" />
      <p className="small">Deadlines are one hour before each round's first kickoff and follow schedule changes until seven days away, then freeze.</p>
      <div className="card scroll-x">
        <table className="table">
          <thead><tr><th>Week</th><th>Deadline</th><th>Matches</th><th>Teams</th><th>State</th><th>Rules</th></tr></thead>
          <tbody>
            {weeks.map((w) => (
              <tr key={w.number}>
                <td className="num">{w.number}</td>
                <td>{fmtDate(w.deadline)}{w.frozen && !w.locked ? " · fixed" : ""}</td>
                <td className="num">{w.finished}/{w.matches}</td>
                <td className="num">{w.locked ? w.teams : "–"}</td>
                <td>{w.locked ? w.status : "open"}</td>
                <td className="small">{w.rules ?? "latest"}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </>
  );
}
