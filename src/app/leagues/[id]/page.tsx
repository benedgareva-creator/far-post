import { notFound, redirect } from "next/navigation";
import { requireUser } from "@/lib/auth";
import { now as gameNow } from "@/lib/clock";
import { one } from "@/lib/db";
import { leaveLeague } from "@/lib/services/leagues";
import { currentWeek } from "@/lib/services/teams";
import { standings } from "@/lib/services/views";
import { AutoRefresh } from "@/components/AutoRefresh";
import { StatusPill } from "@/components/StatusPill";

export const dynamic = "force-dynamic";

async function leave(formData: FormData) {
  "use server";
  const user = await requireUser();
  await leaveLeague(user.id, Number(formData.get("id")));
  redirect("/leagues");
}

export default async function League({ params, searchParams }: { params: Promise<{ id: string }>; searchParams: Promise<{ new?: string }> }) {
  const user = await requireUser();
  const id = Number((await params).id);
  if (!Number.isInteger(id)) notFound();
  const member = await one("SELECT 1 FROM league_members WHERE league_id = $1 AND user_id = $2", [id, user.id]);
  const league = await one<{ name: string; code: string; start_week: number }>("SELECT name, code, start_week FROM leagues WHERE id = $1", [id]);
  if (!league || !member) notFound();
  const now = await gameNow();
  const cur = await currentWeek(now);
  const table = await standings(id, cur?.number ?? null);
  const sp = await searchParams;
  const weekStatus = table.find((t) => t.week_status)?.week_status;
  return (
    <>
      <AutoRefresh />
      <h1>{league.name}</h1>
      <p className="small">Points from Week {league.start_week}. Invite code <strong className="num" style={{ color: "var(--text)" }}>{league.code}</strong></p>
      {sp.new && <div className="notice ok">League created. Share the code {league.code} with friends so they can join.</div>}
      <div className="spread mt">
        <span className="small">{cur ? `Week ${cur.number}` : ""}</span>
        {weekStatus && <StatusPill status={weekStatus} />}
      </div>
      <div className="list mt">
        <div className="row" style={{ minHeight: 0, paddingTop: 8, paddingBottom: 8 }}>
          <span className="rank small">#</span>
          <div className="grow small">Team</div>
          <span className="small" style={{ width: 48, textAlign: "right" }}>Week</span>
          <span className="small" style={{ width: 54, textAlign: "right" }}>Total</span>
        </div>
        {table.map((t) => (
          <a className="row" key={t.user_id} href={t.user_id === user.id ? "/team" : `/teams/${t.user_id}`} style={t.user_id === user.id ? { background: "var(--ok-soft)" } : undefined}>
            <span className={`rank${t.rank === "1" ? " r1" : ""}`} title={t.tied ? "Level on points" : undefined}>{t.tied ? "=" : ""}{t.rank}</span>
            <div className="grow"><div className="title">{t.team_name ?? "Unnamed team"}</div></div>
            <span className="num" style={{ width: 48, textAlign: "right", color: "var(--muted)" }}>{t.week_points ?? "–"}</span>
            <span className="pts" style={{ width: 54 }}>{t.total}</span>
          </a>
        ))}
      </div>
      <form action={leave} className="mt">
        <input type="hidden" name="id" value={id} />
        <button className="btn secondary small" type="submit">Leave league</button>
      </form>
    </>
  );
}
