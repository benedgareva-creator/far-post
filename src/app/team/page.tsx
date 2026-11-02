import { redirect } from "next/navigation";
import { requireUser } from "@/lib/auth";
import { now as gameNow } from "@/lib/clock";
import { q, one } from "@/lib/db";
import { upcomingWeek } from "@/lib/services/teams";
import { clubFixturesForWeek, picksFor } from "@/lib/services/views";
import { LineupEditor } from "@/components/LineupEditor";
import { TeamPoints } from "@/components/TeamPoints";
import { fmtDate } from "@/components/StatusPill";
import { AutoRefresh } from "@/components/AutoRefresh";

export const dynamic = "force-dynamic";

export default async function Team({ searchParams }: { searchParams: Promise<{ week?: string }> }) {
  const user = await requireUser();
  if (!user.team_name) redirect("/welcome");
  const now = await gameNow();
  const next = await upcomingWeek(now);
  const played = await q<{ week_number: number }>("SELECT DISTINCT week_number FROM picks WHERE user_id = $1 AND week_number IS NOT NULL ORDER BY week_number", [user.id]);
  const sp = await searchParams;
  const requested = sp.week ? Number(sp.week) : null;
  const showEdit = requested === null ? played.length === 0 || requested === next?.number : requested === next?.number;
  const week = requested ?? (played.length ? played[played.length - 1].week_number : null);
  const chips = (
    <div className="seg">
      {played.map((w) => <a key={w.week_number} className={`chip${!showEdit && w.week_number === week ? " on" : ""}`} href={`/team?week=${w.week_number}`}>Week {w.week_number}</a>)}
      {next && <a className={`chip${showEdit ? " on" : ""}`} href={`/team?week=${next.number}`}>Week {next.number} · edit</a>}
    </div>
  );

  if (showEdit || week === null) {
    const picks = await picksFor(user.id, null);
    if (!picks.length) redirect("/transfers");
    const fx = next ? await clubFixturesForWeek(next.number) : new Map();
    const clubOf = await q<{ id: number; club_id: number }>("SELECT id, club_id FROM players WHERE id = ANY($1::int[])", [picks.map((p) => p.player_id)]);
    const clubMap = new Map(clubOf.map((c) => [c.id, c.club_id]));
    return (
      <>
        <h1>My team</h1>
        {chips}
        {next && (
          <div className="ribbon">
            <div><div className="label">Week {next.number} deadline</div><div className="num">{fmtDate(next.deadline)}</div></div>
            <a className="chip" href="/transfers" style={{ background: "var(--night)", color: "#fff" }}>Transfers</a>
          </div>
        )}
        <LineupEditor
          initial={picks.map((p) => {
            const games = fx.get(clubMap.get(p.player_id)!) ?? [];
            const next = games.length === 0 ? "No match this Week" : games.map((g: { opp: string; home: boolean }) => `${g.opp} (${g.home ? "H" : "A"})`).join(", ");
            const nextShort = games.length === 0 ? "No match" : games.map((g: { opp: string; home: boolean }) => `${g.opp}${g.home ? "" : " (a)"}`).join(" + ");
            return { playerId: p.player_id, name: p.name, position: p.position, club: p.club_short, slot: p.slot, isCaptain: p.is_captain, isVice: p.is_vice, next, nextShort, kit: p.kit };
          })}
        />
      </>
    );
  }

  const row = await one<{ points: number; status: string; detail: unknown }>("SELECT points, status, detail FROM team_week_points WHERE user_id = $1 AND week_number = $2", [user.id, week]);
  return (
    <>
      <AutoRefresh />
      <h1>My team</h1>
      {chips}
      <TeamPoints userId={user.id} week={week} result={row} />
    </>
  );
}
