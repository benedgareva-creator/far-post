import { notFound } from "next/navigation";
import { requireUser } from "@/lib/auth";
import { one, q } from "@/lib/db";
import { AutoRefresh } from "@/components/AutoRefresh";
import { FixtureRow } from "@/components/FixtureRow";
import { StatusPill } from "@/components/StatusPill";
import { Shirt } from "@/components/Shirt";
import type { FixtureView } from "@/lib/services/views";

export const dynamic = "force-dynamic";

export default async function Match({ params }: { params: Promise<{ id: string }> }) {
  await requireUser();
  const id = Number((await params).id);
  if (!Number.isInteger(id)) notFound();
  const f = await one<FixtureView & { home_club_id: number; away_club_id: number }>(
    `SELECT f.id, f.kickoff, f.status, f.minute, h.name AS home, a.name AS away, h.short_name AS home_short, a.short_name AS away_short,
            f.home_goals, f.away_goals, f.week_number, f.home_club_id, f.away_club_id, h.kit AS home_kit, a.kit AS away_kit
       FROM fixtures f JOIN clubs h ON h.id = f.home_club_id JOIN clubs a ON a.id = f.away_club_id WHERE f.id = $1`,
    [id],
  );
  if (!f) notFound();
  const rows = await q<{ player_id: number; name: string; position: string; club_id: number; points: number; minutes: number; breakdown: { label: string; value: number; points: number }[]; pending: string[]; status: string }>(
    `SELECT pp.player_id, p.name, p.position, s.club_id, pp.points, pp.minutes, pp.breakdown, pp.pending, pp.status
       FROM player_points pp JOIN players p ON p.id = pp.player_id JOIN player_match_stats s ON s.fixture_id = pp.fixture_id AND s.player_id = pp.player_id
      WHERE pp.fixture_id = $1 AND pp.minutes > 0 ORDER BY pp.points DESC, p.name`,
    [id],
  );
  const status = rows[0]?.status;
  return (
    <>
      <AutoRefresh />
      <div className="list mt"><FixtureRow f={f} link={false} /></div>
      {status && <div className="spread mt"><span className="small">Player points</span><StatusPill status={status} partial={rows.some((r) => r.pending.length > 0)} /></div>}
      {[f.home_club_id, f.away_club_id].map((club, i) => (
        <section key={club}>
          <h2>{i === 0 ? f.home : f.away}</h2>
          <div className="list">
            {rows.filter((r) => r.club_id === club).map((r) => (
              <div className="row" key={r.player_id}>
                <span className="mini-shirt"><Shirt kit={(r.club_id === f.home_club_id ? f.home_kit : f.away_kit)} keeper={r.position === "GK"} size={34} /></span>
                <div className="grow">
                  <div className="title">{r.name} <span className="small">{r.position}</span></div>
                  <div className="meta">
                    {r.breakdown.map((b) => `${b.label}${b.value > 1 && b.label !== "Minutes played" ? ` ×${b.value}` : ""} ${b.points > 0 ? "+" : ""}${b.points}`).join(" · ") || `${r.minutes}′`}
                    {r.pending.length > 0 && " · some numbers pending"}
                  </div>
                </div>
                <div className="pts">{r.points}</div>
              </div>
            ))}
            {rows.filter((r) => r.club_id === club).length === 0 && <div className="empty">No player numbers yet.</div>}
          </div>
        </section>
      ))}
    </>
  );
}
