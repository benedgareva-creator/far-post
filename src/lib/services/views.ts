// Read-only queries behind the pages.
import { getSetting, one, q } from "../db";
import type { Position } from "../game/rules";
import type { Kit } from "../kits";
import { FINISHED, LIVE } from "../game/weeks";
import type { TeamWeekResult } from "../scoring/team";
import { currentWeek, upcomingWeek } from "./teams";

export const STALE_MS = 3 * 60_000;

export interface FixtureView {
  id: number;
  kickoff: Date;
  status: string;
  minute: number | null;
  home: string;
  away: string;
  home_short: string;
  away_short: string;
  home_goals: number | null;
  away_goals: number | null;
  week_number: number | null;
  home_kit: Kit;
  away_kit: Kit;
}

export async function weekFixtures(week: number): Promise<FixtureView[]> {
  return q<FixtureView>(
    `SELECT f.id, f.kickoff, f.status, f.minute, h.name AS home, a.name AS away, h.short_name AS home_short, a.short_name AS away_short,
            f.home_goals, f.away_goals, f.week_number, h.kit AS home_kit, a.kit AS away_kit
       FROM fixtures f JOIN clubs h ON h.id = f.home_club_id JOIN clubs a ON a.id = f.away_club_id
      WHERE f.week_number = $1 ORDER BY f.kickoff, f.id`,
    [week],
  );
}

export async function postponedFixtures(): Promise<FixtureView[]> {
  return q<FixtureView>(
    `SELECT f.id, f.kickoff, f.status, f.minute, h.name AS home, a.name AS away, h.short_name AS home_short, a.short_name AS away_short,
            f.home_goals, f.away_goals, f.week_number, h.kit AS home_kit, a.kit AS away_kit
       FROM fixtures f JOIN clubs h ON h.id = f.home_club_id JOIN clubs a ON a.id = f.away_club_id
      WHERE f.week_number IS NULL AND f.status IN ('PST','TBD') ORDER BY f.kickoff`,
  );
}

export function fixtureState(f: Pick<FixtureView, "status" | "minute">): { label: string; live: boolean } {
  if (LIVE.has(f.status)) return { label: f.status === "HT" ? "Half-time" : f.status === "SUSP" || f.status === "INT" ? "Suspended" : `${f.minute ?? ""}'`, live: f.status !== "SUSP" && f.status !== "INT" };
  if (FINISHED.has(f.status)) return { label: "Full time", live: false };
  if (f.status === "PST") return { label: "Postponed", live: false };
  if (f.status === "ABD") return { label: "Abandoned · void", live: false };
  if (f.status === "CANC") return { label: "Cancelled", live: false };
  return { label: "", live: false };
}

export async function freshness(now: Date) {
  const last = await getSetting<string>("last_success");
  const anyLive = await one("SELECT 1 FROM fixtures WHERE status = ANY($1::text[]) LIMIT 1", [[...LIVE]]);
  const stale = !!anyLive && (!last || now.getTime() - new Date(last).getTime() > STALE_MS);
  return { lastSuccess: last ? new Date(last) : null, stale, anyLive: !!anyLive };
}

export async function overview(userId: number, now: Date) {
  const cur = await currentWeek(now);
  const next = await upcomingWeek(now);
  let team: { points: number; status: string; detail: TeamWeekResult } | null = null;
  let average: number | null = null;
  let highest: number | null = null;
  if (cur) {
    team = await one("SELECT points, status, detail FROM team_week_points WHERE user_id = $1 AND week_number = $2", [userId, cur.number]);
    const agg = await one<{ avg: string | null; max: number | null }>("SELECT round(avg(points)) AS avg, max(points) AS max FROM team_week_points WHERE week_number = $1", [cur.number]);
    average = agg?.avg != null ? Number(agg.avg) : null;
    highest = agg?.max ?? null;
  }
  const total = await one<{ s: string | null }>("SELECT sum(points) AS s FROM team_week_points WHERE user_id = $1", [userId]);
  return { cur, next, team, average, highest, total: Number(total?.s ?? 0) };
}

export interface PickView {
  player_id: number;
  name: string;
  position: Position;
  club: string;
  club_short: string;
  slot: number;
  is_captain: boolean;
  is_vice: boolean;
  price: number;
  kit: Kit;
}

export async function picksFor(userId: number, week: number | null): Promise<PickView[]> {
  return q<PickView>(
    `SELECT k.player_id, p.name, p.position, c.name AS club, c.short_name AS club_short, k.slot, k.is_captain, k.is_vice, k.price, c.kit
       FROM picks k JOIN players p ON p.id = k.player_id JOIN clubs c ON c.id = p.club_id
      WHERE k.user_id = $1 AND k.week_number IS NOT DISTINCT FROM $2 ORDER BY k.slot`,
    [userId, week],
  );
}

/** Points breakdown for a set of players in a Week. */
export async function playerWeekPoints(week: number, playerIds: number[]) {
  const rows = await q<{ player_id: number; fixture_id: number; points: number; minutes: number; breakdown: { label: string; value: number; points: number }[]; pending: string[]; status: string }>(
    "SELECT player_id, fixture_id, points, minutes, breakdown, pending, status FROM player_points WHERE week_number = $1 AND player_id = ANY($2::int[])",
    [week, playerIds],
  );
  const map = new Map<number, typeof rows>();
  for (const r of rows) map.set(r.player_id, [...(map.get(r.player_id) ?? []), r]);
  return map;
}

/** Each squad player's matches in a Week (for the "next match" label). */
export async function clubFixturesForWeek(week: number) {
  const rows = await q<{ club_id: number; opp: string; home: boolean; kickoff: Date; status: string }>(
    `SELECT f.home_club_id AS club_id, a.short_name AS opp, true AS home, f.kickoff, f.status FROM fixtures f JOIN clubs a ON a.id = f.away_club_id WHERE f.week_number = $1
     UNION ALL
     SELECT f.away_club_id, h.short_name, false, f.kickoff, f.status FROM fixtures f JOIN clubs h ON h.id = f.home_club_id WHERE f.week_number = $1`,
    [week],
  );
  const map = new Map<number, typeof rows>();
  for (const r of rows) map.set(r.club_id, [...(map.get(r.club_id) ?? []), r]);
  return map;
}

export async function myLeagues(userId: number) {
  return q<{ id: number; name: string; code: string; start_week: number; members: string; rank: string | null; total: string | null; tied: boolean }>(
    `WITH totals AS (
       SELECT m.league_id, m.user_id, COALESCE(sum(t.points), 0) AS total
         FROM league_members m JOIN leagues l ON l.id = m.league_id
         LEFT JOIN team_week_points t ON t.user_id = m.user_id AND t.week_number >= l.start_week
        GROUP BY m.league_id, m.user_id),
     ranked AS (SELECT *, rank() OVER (PARTITION BY league_id ORDER BY total DESC) AS rank,
                       count(*) OVER (PARTITION BY league_id, total) > 1 AS tied FROM totals)
     SELECT l.id, l.name, l.code, l.start_week,
            (SELECT count(*) FROM league_members x WHERE x.league_id = l.id) AS members, r.rank, r.total, r.tied
       FROM leagues l JOIN ranked r ON r.league_id = l.id AND r.user_id = $1 ORDER BY l.name`,
    [userId],
  );
}

/**
 * League table. Tie policy (the same on every screen): teams level on total points share a rank,
 * and the next rank skips (1, 1, 3). Level teams are listed alphabetically.
 */
export async function standings(leagueId: number, week: number | null) {
  return q<{ user_id: number; team_name: string | null; total: string; rank: string; tied: boolean; week_points: number | null; week_status: string | null }>(
    `WITH t AS (
       SELECT u.id AS user_id, u.team_name,
              COALESCE((SELECT sum(t.points) FROM team_week_points t WHERE t.user_id = u.id AND t.week_number >= l.start_week), 0) AS total,
              (SELECT t.points FROM team_week_points t WHERE t.user_id = u.id AND t.week_number = $2) AS week_points,
              (SELECT t.status FROM team_week_points t WHERE t.user_id = u.id AND t.week_number = $2) AS week_status
         FROM league_members m JOIN users u ON u.id = m.user_id JOIN leagues l ON l.id = m.league_id
        WHERE m.league_id = $1)
     SELECT t.*, rank() OVER (ORDER BY total DESC) AS rank, count(*) OVER (PARTITION BY total) > 1 AS tied
       FROM t ORDER BY total DESC, team_name`,
    [leagueId, week],
  );
}

export async function catalogue() {
  return q<{ id: number; name: string; position: Position; price: number; club_id: number; club: string; club_short: string; points: string; kit: Kit }>(
    `SELECT p.id, p.name, p.position, p.price, p.club_id, c.name AS club, c.short_name AS club_short, c.kit,
            COALESCE((SELECT sum(x.points) FROM player_points x WHERE x.player_id = p.id), 0) AS points
       FROM players p JOIN clubs c ON c.id = p.club_id
      WHERE p.published AND p.approved AND p.price IS NOT NULL ORDER BY p.price DESC, p.name`,
  );
}
