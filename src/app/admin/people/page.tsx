import { redirect } from "next/navigation";
import { inviteEmails, requireAdmin, withdrawInvite } from "@/lib/auth";
import { logAdmin } from "@/lib/services/alerts";
import { q } from "@/lib/db";
import { AdminNav } from "@/components/AdminNav";
import { fmtDate } from "@/components/StatusPill";

export const dynamic = "force-dynamic";

async function invite(formData: FormData) {
  "use server";
  const admin = await requireAdmin();
  const r = await inviteEmails(admin.id, String(formData.get("emails") ?? ""));
  await logAdmin(admin.id, "invite", { invited: r.invited.length });
  const parts = [`Invited ${r.invited.length}.`];
  if (r.skipped.length) parts.push(`Skipped ${r.skipped.length} (already invited or not an email).`);
  if (r.notEmailed.length) parts.push(`Could not email ${r.notEmailed.join(", ")}: they can still sign in at the login page.`);
  redirect(`/admin/people?m=${encodeURIComponent(parts.join(" "))}`);
}

async function withdraw(formData: FormData) {
  "use server";
  const admin = await requireAdmin();
  await withdrawInvite(String(formData.get("email") ?? ""));
  await logAdmin(admin.id, "withdraw invite", {});
  redirect("/admin/people");
}

export default async function People({ searchParams }: { searchParams: Promise<{ m?: string }> }) {
  await requireAdmin();
  const { m } = await searchParams;
  const pending = await q<{ email: string; created_at: Date }>("SELECT email, created_at FROM invites WHERE used_at IS NULL ORDER BY created_at DESC");
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
      {m && <div className="notice ok">{m}</div>}
      <h2>Invite people</h2>
      <div className="card">
        <p className="small">Far Post is invite-only: only emails on this list (and existing players) can sign in. Each person gets an email telling them how.</p>
        <form action={invite} className="mt">
          <label htmlFor="emails">Email addresses (one per line, or separated by commas)</label>
          <textarea id="emails" name="emails" rows={3} required placeholder={"sam@example.com\nalex@example.com"} />
          <button className="btn block mt" type="submit">Send invitations</button>
        </form>
      </div>
      {pending.length > 0 && (
        <>
          <h2>Invited, not signed in yet ({pending.length})</h2>
          <div className="list">
            {pending.map((i) => (
              <div className="row" key={i.email}>
                <div className="grow"><div className="title">{i.email}</div><div className="meta">Invited {fmtDate(i.created_at)}</div></div>
                <form action={withdraw}><input type="hidden" name="email" value={i.email} /><button className="btn secondary small" type="submit">Withdraw</button></form>
              </div>
            ))}
          </div>
        </>
      )}
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
