import { notFound } from "next/navigation";
import { requireUser } from "@/lib/auth";
import { now as gameNow } from "@/lib/clock";
import { one } from "@/lib/db";
import { currentWeek } from "@/lib/services/teams";
import { TeamPoints } from "@/components/TeamPoints";

export const dynamic = "force-dynamic";

// A rival's team. Only locked Weeks are shown, so choices stay hidden until the deadline.
export default async function Rival({ params, searchParams }: { params: Promise<{ id: string }>; searchParams: Promise<{ week?: string }> }) {
  await requireUser();
  const id = Number((await params).id);
  const now = await gameNow();
  const cur = await currentWeek(now);
  const week = Math.min(Number((await searchParams).week) || cur?.number || 0, cur?.number ?? 0);
  const user = await one<{ team_name: string }>("SELECT team_name FROM users WHERE id = $1", [id]);
  if (!user || !Number.isInteger(id)) notFound();
  const locked = await one("SELECT 1 FROM weeks WHERE number = $1 AND locked", [week]);
  const row = locked ? await one<{ points: number; status: string; detail: unknown }>("SELECT points, status, detail FROM team_week_points WHERE user_id = $1 AND week_number = $2", [id, week]) : null;
  return (
    <>
      <h1>{user.team_name}</h1>
      {row ? <TeamPoints userId={id} week={week} result={row} /> : <div className="empty">This team has no locked lineup for Week {week} yet. Picks are hidden until the deadline.</div>}
    </>
  );
}
