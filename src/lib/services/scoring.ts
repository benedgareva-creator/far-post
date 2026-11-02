// Turns stored match numbers into points, using the rules each Week locked with.
import { one, q, type Db, pool } from "../db";
import type { Position } from "../game/rules";
import { FINISHED, VOID } from "../game/weeks";
import { scorePlayerMatch } from "../scoring/engine";
import { DEFAULT_RULES, parseRules, type ScoringRules, type StatLine } from "../scoring/rules";
import { scoreTeamWeek, type PlayerWeekFixture, type PointsStatus, type TeamPick } from "../scoring/team";

export const FINAL_AFTER_MS = 72 * 3600_000;

/** The rules a Week uses: the ones it locked with, or (before lock) the latest published set that applies. */
export async function rulesForWeek(week: number, db: Db = pool()): Promise<{ id: number; rules: ScoringRules }> {
  const locked = await one<{ id: number; config: unknown }>("SELECT r.id, r.config FROM weeks w JOIN rulesets r ON r.id = w.ruleset_id WHERE w.number = $1", [week], db);
  if (locked) return { id: locked.id, rules: parseRules(locked.config) };
  const latest = await one<{ id: number; config: unknown }>(
    "SELECT id, config FROM rulesets WHERE status = 'published' AND (from_week IS NULL OR from_week <= $1) ORDER BY from_week DESC NULLS LAST, id DESC LIMIT 1",
    [week],
    db,
  );
  if (latest) return { id: latest.id, rules: parseRules(latest.config) };
  const created = await one<{ id: number }>(
    "INSERT INTO rulesets (name, config, status, from_week, published_at) VALUES ('Standard rules', $1, 'published', 1, now()) RETURNING id",
    [JSON.stringify(DEFAULT_RULES)],
    db,
  );
  return { id: created!.id, rules: DEFAULT_RULES };
}

interface StatRow {
  player_id: number;
  position: Position;
  club_id: number;
  home_club_id: number;
  home_goals: number | null;
  away_goals: number | null;
  minutes: number | null;
  goals: number | null;
  assists: number | null;
  saves: number | null;
  yellow: number | null;
  red: number | null;
  own_goals: number | null;
  pen_saved: number | null;
  pen_missed: number | null;
}

export function statLine(r: Omit<StatRow, "player_id" | "position">): StatLine {
  const conceded = r.club_id === r.home_club_id ? r.away_goals : r.home_goals;
  return {
    minutes: r.minutes,
    goals: r.goals,
    assists: r.assists,
    saves: r.saves,
    yellow: r.yellow,
    red: r.red,
    ownGoals: r.own_goals,
    penSaved: r.pen_saved,
    penMissed: r.pen_missed,
    clubConceded: conceded,
  };
}

/** Recomputes every player's points for one match. Final points are never touched here. */
export async function rescoreFixture(fixtureId: number, now: Date, db: Db = pool()): Promise<number | null> {
  const f = await one<{ id: number; week_number: number | null; status: string; finished_at: Date | null }>(
    "SELECT id, week_number, status, finished_at FROM fixtures WHERE id = $1",
    [fixtureId],
    db,
  );
  if (!f) return null;
  if (f.week_number === null || VOID.has(f.status)) {
    // Not in any Week (before launch, postponed) or abandoned: no points.
    await q("DELETE FROM player_points WHERE fixture_id = $1 AND status <> 'final'", [fixtureId], db);
    if (VOID.has(f.status)) await q("DELETE FROM player_points WHERE fixture_id = $1", [fixtureId], db);
    return f.week_number;
  }
  const { id: rulesetId, rules } = await rulesForWeek(f.week_number, db);
  const rows = await q<StatRow>(
    `SELECT s.*, p.position, fx.home_club_id, fx.home_goals, fx.away_goals
       FROM player_match_stats s JOIN players p ON p.id = s.player_id JOIN fixtures fx ON fx.id = s.fixture_id
      WHERE s.fixture_id = $1`,
    [fixtureId],
    db,
  );
  const finished = FINISHED.has(f.status);
  let anyPending = false;
  for (const r of rows) {
    const score = scorePlayerMatch(statLine(r), r.position, rules);
    if (score.pending.length) anyPending = true;
    const status: PointsStatus = finished ? "provisional" : "live";
    await q(
      `INSERT INTO player_points (fixture_id, player_id, week_number, points, minutes, breakdown, pending, status, ruleset_id, updated_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9, now())
       ON CONFLICT (fixture_id, player_id) DO UPDATE SET
         week_number = EXCLUDED.week_number, points = EXCLUDED.points, minutes = EXCLUDED.minutes, breakdown = EXCLUDED.breakdown,
         pending = EXCLUDED.pending, status = EXCLUDED.status, ruleset_id = EXCLUDED.ruleset_id, updated_at = now()
       WHERE player_points.status <> 'final'`,
      [fixtureId, r.player_id, f.week_number, score.points, score.minutes, JSON.stringify(score.breakdown), JSON.stringify(score.pending), status, rulesetId],
      db,
    );
  }
  await q("UPDATE fixtures SET data_complete = $2 WHERE id = $1", [fixtureId, finished && rows.length > 0 && !anyPending], db);
  // 72 hours after full time with complete data, points become final.
  if (finished && rows.length > 0 && !anyPending && f.finished_at && now.getTime() - f.finished_at.getTime() >= FINAL_AFTER_MS) {
    await q("UPDATE player_points SET status = 'final' WHERE fixture_id = $1", [fixtureId], db);
  }
  return f.week_number;
}

/** Recomputes every locked team's total for a Week. */
export async function rescoreWeek(week: number, db: Db = pool()) {
  const users = await q<{ user_id: number }>("SELECT DISTINCT user_id FROM picks WHERE week_number = $1", [week], db);
  for (const u of users) await rescoreTeamWeek(u.user_id, week, db);
  const statuses = await q<{ status: string }>("SELECT DISTINCT status FROM team_week_points WHERE week_number = $1", [week], db);
  const weekStatus = await weekStatusFor(week, db);
  if (statuses.length || weekStatus !== "upcoming") await q("UPDATE weeks SET status = $2 WHERE number = $1 AND locked", [week, weekStatus], db);
}

async function weekStatusFor(week: number, db: Db): Promise<string> {
  const fx = await q<{ status: string; final: boolean }>(
    `SELECT f.status, COALESCE(bool_and(pp.status = 'final'), false) AS final
       FROM fixtures f LEFT JOIN player_points pp ON pp.fixture_id = f.id
      WHERE f.week_number = $1 GROUP BY f.id`,
    [week],
    db,
  );
  if (fx.length === 0) return "live";
  const open = fx.filter((f) => !VOID.has(f.status));
  if (open.some((f) => !FINISHED.has(f.status))) return "live";
  if (open.every((f) => f.final)) return "final";
  return "provisional";
}

/** What each player in a set did in a Week: one entry per match (doubles have two). */
export async function playerWeekFixtures(week: number, playerIds: number[], db: Db = pool()): Promise<Map<number, PlayerWeekFixture[]>> {
  const map = new Map<number, PlayerWeekFixture[]>();
  if (playerIds.length === 0) return map;
  const rows = await q<{
    player_id: number;
    fixture_id: number;
    fstatus: string;
    points: number | null;
    minutes: number | null;
    pstatus: PointsStatus | null;
    pending: string[] | null;
    fixture_final: boolean | null;
  }>(
    `SELECT p.id AS player_id, f.id AS fixture_id, f.status AS fstatus, pp.points, pp.minutes, pp.status AS pstatus, pp.pending,
            (SELECT bool_or(x.status = 'final') FROM player_points x WHERE x.fixture_id = f.id) AS fixture_final
       FROM players p
       JOIN fixtures f ON f.week_number = $1
        AND (f.home_club_id = p.club_id OR f.away_club_id = p.club_id
             OR EXISTS (SELECT 1 FROM player_points x WHERE x.fixture_id = f.id AND x.player_id = p.id))
       LEFT JOIN player_points pp ON pp.fixture_id = f.id AND pp.player_id = p.id
      WHERE p.id = ANY($2::int[])`,
    [week, playerIds],
    db,
  );
  for (const r of rows) {
    if (VOID.has(r.fstatus)) continue; // abandoned: void
    const finished = FINISHED.has(r.fstatus);
    const entry: PlayerWeekFixture = {
      fixtureId: r.fixture_id,
      points: r.points ?? 0,
      minutes: r.minutes ?? 0,
      resolved: finished,
      // A player who did not feature has no points row: use the match's own status.
      status: r.pstatus ?? (r.fixture_final ? "final" : finished ? "provisional" : "live"),
      pending: (r.pending ?? []).length > 0,
    };
    map.set(r.player_id, [...(map.get(r.player_id) ?? []), entry]);
  }
  return map;
}

export async function teamWeekResult(userId: number, week: number, db: Db = pool()) {
  const picks = await q<{ player_id: number; position: Position; slot: number; is_captain: boolean; is_vice: boolean }>(
    "SELECT k.player_id, p.position, k.slot, k.is_captain, k.is_vice FROM picks k JOIN players p ON p.id = k.player_id WHERE k.user_id = $1 AND k.week_number = $2",
    [userId, week],
    db,
  );
  if (picks.length === 0) return null;
  const teamPicks: TeamPick[] = picks.map((p) => ({ playerId: p.player_id, position: p.position, slot: p.slot, isCaptain: p.is_captain, isVice: p.is_vice }));
  const fixtures = await playerWeekFixtures(week, teamPicks.map((p) => p.playerId), db);
  return scoreTeamWeek(teamPicks, fixtures);
}

export async function rescoreTeamWeek(userId: number, week: number, db: Db = pool()) {
  const result = await teamWeekResult(userId, week, db);
  if (!result) return;
  await q(
    `INSERT INTO team_week_points (user_id, week_number, points, detail, status, updated_at) VALUES ($1,$2,$3,$4,$5, now())
     ON CONFLICT (user_id, week_number) DO UPDATE SET points = EXCLUDED.points, detail = EXCLUDED.detail, status = EXCLUDED.status, updated_at = now()`,
    [userId, week, result.points, JSON.stringify(result), result.status],
    db,
  );
}

/** Scores one player's numbers under some rules without saving (used for previews and corrections). */
export function previewScore(stats: StatLine, position: Position, rules: ScoringRules) {
  return scorePlayerMatch(stats, position, rules);
}
