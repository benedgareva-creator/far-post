import { requireAdmin } from "@/lib/auth";
import { q } from "@/lib/db";
import { AdminNav } from "@/components/AdminNav";
import { fmtDate } from "@/components/StatusPill";

export const dynamic = "force-dynamic";

export default async function People() {
  await requireAdmin();
  const users = await q<{ id: number; email: string; team_name: string | null; joined_week: number | null; is_admin: boolean; created_at: Date; total: string }>(
    "SELECT u.id, u.email, u.team_name, u.joined_week, u.is_admin, u.created_at, COALESCE((SELECT sum(points) FROM team_week_points t WHERE t.user_id = u.id), 0) AS total FROM users u ORDER BY u.created_at",
  );
  const leagues = await q<{ id: number; name: string; code: string; start_week: number; members: string; owner: string | null }>(
    "SELECT l.id, l.name, l.code, l.start_week, (SELECT count(*) FROM league_members m WHERE m.league_id = l.id) AS members, u.team_name AS owner FROM leagues l LEFT JOIN users u ON u.id = l.owner_id ORDER BY l.created_at",
  );
  const log = await q<{ at: Date; action: string; email: string | null; details: unknown }>(
    "SELECT a.at, a.action, u.email, a.details FROM admin_log a LEFT JOIN users u ON u.id = a.user_id ORDER BY a.at DESC LIMIT 40",
  );
  return (
    <>
      <AdminNav active="/admin/people" />
      <h2>People ({users.length})</h2>
      <div className="card scroll-x">
        <table className="table">
          <thead><tr><th>Team</th><th>Email</th><th>From</th><th>Points</th></tr></thead>
          <tbody>{users.map((u) => <tr key={u.id}><td>{u.team_name ?? "–"}{u.is_admin ? " (admin)" : ""}</td><td className="small">{u.email}</td><td className="num">{u.joined_week ? `W${u.joined_week}` : "–"}</td><td className="num">{u.total}</td></tr>)}</tbody>
        </table>
      </div>
      <h2>Leagues ({leagues.length})</h2>
      <div className="list">{leagues.map((l) => <div className="row" key={l.id}><div className="grow"><div className="title">{l.name}</div><div className="meta">Code {l.code} · {l.members} teams · from Week {l.start_week}{l.owner ? ` · started by ${l.owner}` : ""}</div></div></div>)}</div>
      <h2>Admin log</h2>
      <div className="list">{log.map((a, i) => <div className="row" key={i}><div className="grow"><div className="title">{a.action}</div><div className="meta">{a.email ?? "system"} · {fmtDate(a.at)}</div></div></div>)}</div>
    </>
  );
}
