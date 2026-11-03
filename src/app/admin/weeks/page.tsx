import { redirect } from "next/navigation";
import { requireAdmin } from "@/lib/auth";
import { setLaunchRound, setupStatus } from "@/lib/services/admin";
import { GameError } from "@/lib/services/teams";
import { q } from "@/lib/db";
import { AdminNav } from "@/components/AdminNav";
import { fmtDate } from "@/components/StatusPill";

export const dynamic = "force-dynamic";

async function launch(formData: FormData) {
  "use server";
  const admin = await requireAdmin();
  try {
    await setLaunchRound(admin.id, Number(formData.get("round")));
  } catch (e) {
    if (e instanceof GameError) redirect(`/admin/weeks?err=${encodeURIComponent(e.message)}`);
    throw e;
  }
  redirect("/admin/weeks?m=" + encodeURIComponent("Saved. The Weeks will be rebuilt from the fixture list within a minute or two."));
}

export default async function Weeks({ searchParams }: { searchParams: Promise<{ m?: string; err?: string }> }) {
  await requireAdmin();
  const sp = await searchParams;
  const setup = await setupStatus();
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
      {sp.m && <div className="notice ok">{sp.m}</div>}
      {sp.err && <div className="notice error">{sp.err}</div>}
      {!setup.started && (
        <div className="card">
          <h2 style={{ marginTop: 0 }}>Before launch</h2>
          <ol className="small" style={{ paddingLeft: 18, lineHeight: 1.7 }}>
            <li>{setup.clubs > 0 ? "✓" : "○"} Clubs loaded: {setup.clubs}</li>
            <li>{setup.players > 0 ? "✓" : "○"} Players approved: {setup.players} ({setup.priced} priced and published)</li>
            <li>{setup.fixtures > 0 ? "✓" : "○"} Matches loaded: {setup.fixtures}{setup.fixturesPending ? " (refreshing…)" : ""}</li>
            <li>{setup.weeks > 0 ? "✓" : "○"} Weeks built: {setup.weeks}, starting from round {setup.launchRound}</li>
          </ol>
          <p className="small">Choose which round of the real season is Week 1. This can change only until the first deadline passes.</p>
          <form action={launch} className="grid2 mt">
            <input name="round" type="number" min={1} max={60} defaultValue={setup.launchRound} aria-label="Launch round" />
            <button className="btn" type="submit">Set Week 1</button>
          </form>
        </div>
      )}
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
