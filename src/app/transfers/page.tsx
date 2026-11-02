import { redirect } from "next/navigation";
import { requireUser } from "@/lib/auth";
import { now as gameNow } from "@/lib/clock";
import { q } from "@/lib/db";
import { transferStatus, upcomingWeek } from "@/lib/services/teams";
import { catalogue } from "@/lib/services/views";
import { SquadBuilder, TransferMarket } from "@/components/SquadPicker";
import { fmtDate } from "@/components/StatusPill";
import type { Position } from "@/lib/game/rules";
import type { Kit } from "@/lib/kits";

export const dynamic = "force-dynamic";

export default async function Transfers() {
  const user = await requireUser();
  if (!user.team_name) redirect("/welcome");
  const now = await gameNow();
  const next = await upcomingWeek(now);
  const cat = (await catalogue()).map((p) => ({ ...p, points: Number(p.points) }));
  const squad = await q<{ id: number; name: string; position: Position; price: number; club_id: number; club_short: string; purchase_price: number; points: string; kit: Kit }>(
    `SELECT p.id, p.name, p.position, p.price, p.club_id, c.short_name AS club_short, c.kit, s.purchase_price,
            COALESCE((SELECT sum(x.points) FROM player_points x WHERE x.player_id = p.id), 0) AS points
       FROM squad_players s JOIN players p ON p.id = s.player_id JOIN clubs c ON c.id = p.club_id WHERE s.user_id = $1`,
    [user.id],
  );
  const status = await transferStatus(user.id, now);
  return (
    <>
      <h1>{squad.length ? "Transfers" : "Pick your squad"}</h1>
      {next ? (
        <p className="small">
          {squad.length ? "Changes count from" : "Your team starts at"} the Week {next.number} deadline: <strong>{fmtDate(next.deadline)}</strong>.
          {!squad.length && " 14 players: 2 goalkeepers, 4 defenders, 5 midfielders, 3 forwards, at most 3 from one club, within 100."}
        </p>
      ) : (
        <div className="notice">There is no upcoming deadline, so changes are closed.</div>
      )}
      {cat.length === 0 && <div className="notice warn">Player prices are not published yet. Check back soon.</div>}
      {next && cat.length > 0 && (squad.length ? (
        <TransferMarket catalogue={cat} squad={squad.map((p) => ({ ...p, points: Number(p.points) }))} bank={status.bank} remaining={status.remaining} />
      ) : (
        <SquadBuilder catalogue={cat} />
      ))}
    </>
  );
}
