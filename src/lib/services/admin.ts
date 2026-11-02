// Ben's admin tools: prices, scoring rules, corrections, players. Every change is logged.
import { getSetting, one, q, setSetting, tx, type Db, pool } from "../db";
import { suggestPrices } from "../game/pricing";
import type { Position } from "../game/rules";
import { scorePlayerMatch } from "../scoring/engine";
import { parseRules, type ScoringRules } from "../scoring/rules";
import { scoreTeamWeek, type TeamPick } from "../scoring/team";
import { logAdmin } from "./alerts";
import { playerWeekFixtures, rescoreWeek, rulesForWeek, statLine } from "./scoring";
import { GameError } from "./teams";

/** Works out suggested prices from this season's numbers and stores them for review. */
export async function refreshSuggestions(db: Db = pool()) {
  const players = await q<{ id: number; position: Position; season_goals: number | null; season_assists: number | null; season_minutes: number | null }>(
    "SELECT id, position, season_goals, season_assists, season_minutes FROM players WHERE approved",
    [],
    db,
  );
  const latest = await one<{ config: unknown }>("SELECT config FROM rulesets WHERE status = 'published' ORDER BY id DESC LIMIT 1", [], db);
  const rules = latest ? parseRules(latest.config) : (await import("../scoring/rules")).DEFAULT_RULES;
  const suggestions = suggestPrices(
    players.map((p) => ({ id: p.id, position: p.position, goals: p.season_goals, assists: p.season_assists, minutes: p.season_minutes })),
    rules.goal.points,
  );
  for (const s of suggestions) await q("UPDATE players SET suggested_price = $2, suggestion_note = $3 WHERE id = $1", [s.id, s.price, s.note], db);
  return suggestions.length;
}

export async function setPlayerPrice(adminId: number | null, playerId: number, price: number, position?: Position) {
  if (![4, 6, 8, 10].includes(price)) throw new GameError("Prices are 4, 6, 8 or 10.");
  const p = await one<{ published: boolean; approved: boolean }>("SELECT published, approved FROM players WHERE id = $1", [playerId]);
  if (!p) throw new GameError("No such player.");
  if (p.published && p.approved) throw new GameError("Published prices and positions stay fixed for the season.");
  await q("UPDATE players SET price = $2, position = COALESCE($3, position) WHERE id = $1", [playerId, price, position ?? null]);
  await logAdmin(adminId, "set price", { playerId, price, position });
}

/** Publishes all prices (Ben's edits, otherwise the suggestion). After this, prices and positions are fixed. */
export async function publishPrices(adminId: number | null, opts: { useSuggestions?: boolean } = {}) {
  if ((await getSetting<boolean>("prices_published")) === true) throw new GameError("Prices are already published.");
  if (opts.useSuggestions) await refreshSuggestions();
  await q("UPDATE players SET price = COALESCE(price, suggested_price, 6), published = true WHERE approved");
  await setSetting("prices_published", true);
  await logAdmin(adminId, "publish prices", {});
}

/** Approves a player who arrived after launch (e.g. a new signing), with a price Ben chooses. */
export async function approvePlayer(adminId: number, playerId: number, price: number) {
  if (![4, 6, 8, 10].includes(price)) throw new GameError("Prices are 4, 6, 8 or 10.");
  await q("UPDATE players SET approved = true, published = true, price = $2 WHERE id = $1 AND NOT approved", [playerId, price]);
  await logAdmin(adminId, "approve player", { playerId, price });
}

export async function saveDraftRules(adminId: number, name: string, rules: unknown): Promise<number> {
  const parsed = parseRules(rules);
  const existing = await one<{ id: number }>("SELECT id FROM rulesets WHERE status = 'draft' ORDER BY id DESC LIMIT 1");
  let id: number;
  if (existing) {
    await q("UPDATE rulesets SET name = $2, config = $3 WHERE id = $1", [existing.id, name, JSON.stringify(parsed)]);
    id = existing.id;
  } else {
    id = (await one<{ id: number }>("INSERT INTO rulesets (name, config) VALUES ($1,$2) RETURNING id", [name, JSON.stringify(parsed)]))!.id;
  }
  await logAdmin(adminId, "save draft rules", { id, name });
  return id;
}

/** Publishes the draft for the next Week whose deadline has not passed. Past Weeks keep their rules. */
export async function publishDraftRules(adminId: number, now: Date) {
  const draft = await one<{ id: number }>("SELECT id FROM rulesets WHERE status = 'draft' ORDER BY id DESC LIMIT 1");
  if (!draft) throw new GameError("There is no draft to publish.");
  const next = await one<{ number: number }>("SELECT number FROM weeks WHERE NOT locked AND deadline > $1 ORDER BY number LIMIT 1", [now]);
  if (!next) throw new GameError("There is no upcoming Week.");
  await q("UPDATE rulesets SET status = 'published', from_week = $2, published_at = now() WHERE id = $1", [draft.id, next.number]);
  await logAdmin(adminId, "publish rules", { id: draft.id, fromWeek: next.number });
  return next.number;
}

/** How last Week would have scored under some rules (nothing is saved). */
export async function previewRules(rules: ScoringRules, now: Date) {
  const last = await one<{ number: number }>("SELECT number FROM weeks WHERE locked AND deadline <= $1 ORDER BY number DESC LIMIT 1", [now]);
  if (!last) return null;
  const stats = await q<Parameters<typeof statLine>[0] & { player_id: number; position: Position; fixture_id: number; name: string }>(
    `SELECT s.*, p.position, p.name, fx.home_club_id, fx.home_goals, fx.away_goals
       FROM player_match_stats s JOIN players p ON p.id = s.player_id JOIN fixtures fx ON fx.id = s.fixture_id
      WHERE fx.week_number = $1`,
    [last.number],
  );
  const current = await rulesForWeek(last.number);
  const players = new Map<number, { name: string; now: number; draft: number }>();
  const draftPoints = new Map<string, { points: number; minutes: number }>();
  for (const s of stats) {
    const line = statLine(s);
    const a = scorePlayerMatch(line, s.position, current.rules).points;
    const b = scorePlayerMatch(line, s.position, rules);
    draftPoints.set(`${s.fixture_id}:${s.player_id}`, { points: b.points, minutes: b.minutes });
    const e = players.get(s.player_id) ?? { name: s.name, now: 0, draft: 0 };
    e.now += a;
    e.draft += b.points;
    players.set(s.player_id, e);
  }
  // Team totals under the draft (same lineups, captaincy and substitutions).
  const teams = await q<{ user_id: number; team_name: string; points: number }>(
    "SELECT t.user_id, u.team_name, t.points FROM team_week_points t JOIN users u ON u.id = t.user_id WHERE t.week_number = $1",
    [last.number],
  );
  const teamRows = [];
  for (const t of teams) {
    const picks = await q<{ player_id: number; position: Position; slot: number; is_captain: boolean; is_vice: boolean }>(
      "SELECT k.player_id, p.position, k.slot, k.is_captain, k.is_vice FROM picks k JOIN players p ON p.id = k.player_id WHERE k.user_id = $1 AND k.week_number = $2",
      [t.user_id, last.number],
    );
    const tp: TeamPick[] = picks.map((p) => ({ playerId: p.player_id, position: p.position, slot: p.slot, isCaptain: p.is_captain, isVice: p.is_vice }));
    const fx = await playerWeekFixtures(last.number, tp.map((p) => p.playerId));
    for (const [pid, list] of fx) {
      fx.set(pid, list.map((f) => ({ ...f, points: draftPoints.get(`${f.fixtureId}:${pid}`)?.points ?? 0 })));
    }
    teamRows.push({ team: t.team_name, now: t.points, draft: scoreTeamWeek(tp, fx).points });
  }
  const changed = [...players.values()].filter((p) => p.now !== p.draft).sort((a, b) => Math.abs(b.draft - b.now) - Math.abs(a.draft - a.now));
  return { week: last.number, teams: teamRows.sort((a, b) => b.draft - a.draft), changedPlayers: changed.slice(0, 30), changedCount: changed.length };
}

export async function waitingCorrections() {
  const rows = await q<{
    id: number;
    fixture_id: number;
    player_id: number;
    name: string;
    position: Position;
    week_number: number;
    old_stats: Record<string, number | null>;
    new_stats: Record<string, number | null>;
    club_id: number;
    home_club_id: number;
    home_goals: number | null;
    away_goals: number | null;
    created_at: Date;
  }>(
    `SELECT c.id, c.fixture_id, c.player_id, p.name, p.position, f.week_number, c.old_stats, c.new_stats, p.club_id, f.home_club_id, f.home_goals, f.away_goals, c.created_at
       FROM corrections c JOIN players p ON p.id = c.player_id JOIN fixtures f ON f.id = c.fixture_id
      WHERE c.status = 'waiting' ORDER BY c.created_at`,
  );
  const out = [];
  for (const r of rows) {
    const { rules } = await rulesForWeek(r.week_number);
    const base = { club_id: r.club_id, home_club_id: r.home_club_id, home_goals: r.home_goals, away_goals: r.away_goals };
    const oldPts = scorePlayerMatch(statLine({ ...base, ...(r.old_stats as object) } as Parameters<typeof statLine>[0]), r.position, rules).points;
    const newPts = scorePlayerMatch(statLine({ ...base, ...(r.new_stats as object) } as Parameters<typeof statLine>[0]), r.position, rules).points;
    out.push({ ...r, oldPoints: oldPts, newPoints: newPts });
  }
  return out;
}

/** Applies a correction with the Week's original rules and locked teams, then updates league totals. */
export async function decideCorrection(adminId: number, id: number, approve: boolean) {
  const c = await one<{ fixture_id: number; player_id: number; new_stats: Record<string, number | null>; status: string }>(
    "SELECT fixture_id, player_id, new_stats, status FROM corrections WHERE id = $1",
    [id],
  );
  if (!c || c.status !== "waiting") throw new GameError("That correction has already been decided.");
  if (!approve) {
    await q("UPDATE corrections SET status = 'rejected', decided_by = $2, decided_at = now() WHERE id = $1", [id, adminId]);
    await logAdmin(adminId, "reject correction", { id });
    return;
  }
  const week = await tx(async (db) => {
    const s = c.new_stats;
    await q(
      `INSERT INTO player_match_stats (fixture_id, player_id, club_id, minutes, goals, assists, saves, yellow, red, own_goals, pen_saved, pen_missed)
       SELECT $1, $2, p.club_id, $3,$4,$5,$6,$7,$8,$9,$10,$11 FROM players p WHERE p.id = $2
       ON CONFLICT (fixture_id, player_id) DO UPDATE SET minutes=EXCLUDED.minutes, goals=EXCLUDED.goals, assists=EXCLUDED.assists, saves=EXCLUDED.saves,
         yellow=EXCLUDED.yellow, red=EXCLUDED.red, own_goals=EXCLUDED.own_goals, pen_saved=EXCLUDED.pen_saved, pen_missed=EXCLUDED.pen_missed, updated_at=now()`,
      [c.fixture_id, c.player_id, s.minutes, s.goals, s.assists, s.saves, s.yellow, s.red, s.own_goals, s.pen_saved, s.pen_missed],
      db,
    );
    const r = await one<Parameters<typeof statLine>[0] & { position: Position; week_number: number }>(
      `SELECT s.*, p.position, fx.week_number, fx.home_club_id, fx.home_goals, fx.away_goals FROM player_match_stats s
         JOIN players p ON p.id = s.player_id JOIN fixtures fx ON fx.id = s.fixture_id WHERE s.fixture_id = $1 AND s.player_id = $2`,
      [c.fixture_id, c.player_id],
      db,
    );
    const { id: rulesetId, rules } = await rulesForWeek(r!.week_number, db);
    const score = scorePlayerMatch(statLine(r!), r!.position, rules);
    await q(
      `INSERT INTO player_points (fixture_id, player_id, week_number, points, minutes, breakdown, pending, status, ruleset_id)
       VALUES ($1,$2,$3,$4,$5,$6,$7,'final',$8)
       ON CONFLICT (fixture_id, player_id) DO UPDATE SET points = EXCLUDED.points, minutes = EXCLUDED.minutes, breakdown = EXCLUDED.breakdown, pending = EXCLUDED.pending, updated_at = now()`,
      [c.fixture_id, c.player_id, r!.week_number, score.points, score.minutes, JSON.stringify(score.breakdown), JSON.stringify(score.pending), rulesetId],
      db,
    );
    await q("UPDATE corrections SET status = 'approved', decided_by = $2, decided_at = now() WHERE id = $1", [id, adminId], db);
    return r!.week_number;
  });
  await rescoreWeek(week);
  await logAdmin(adminId, "approve correction", { id, week });
}

/** Everything in the database as JSON, for Ben's weekly download. */
export async function exportBackup() {
  const tables = ["users", "clubs", "players", "rulesets", "weeks", "fixtures", "player_match_stats", "player_points", "squad_players", "picks", "transfers", "team_week_points", "leagues", "league_members", "corrections", "alerts", "admin_log", "settings"];
  const out: Record<string, unknown[]> = {};
  for (const t of tables) out[t] = await q(`SELECT * FROM ${t}`);
  return { app: "far-post", version: 1, createdAt: new Date().toISOString(), tables: out };
}
