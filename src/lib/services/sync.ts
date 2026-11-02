// Copies clubs, players and the fixture list from the data supplier into our database,
// and keeps Week deadlines and match-to-Week assignments up to date.
import { kitFor } from "../kits";
import { getSetting, one, q, type Db, pool } from "../db";
import { assignFixtureWeek, FINISHED, LIVE, nextDeadline, VOID, type WeekTiming } from "../game/weeks";
import type { FixtureDetail, FootballProvider, ProviderFixture, ProviderPlayer } from "../provider/types";

export async function upsertClubs(provider: FootballProvider, db: Db = pool()) {
  const res = await provider.getClubs();
  if (!res.ok) return res;
  for (const c of res.data) {
    await q(
      `INSERT INTO clubs (provider_id, name, short_name, kit) VALUES ($1,$2,$3,$4)
       ON CONFLICT (provider_id) DO UPDATE SET name = EXCLUDED.name, short_name = EXCLUDED.short_name, kit = COALESCE(clubs.kit, EXCLUDED.kit)`,
      [c.providerId, c.name, c.shortName, JSON.stringify(kitFor(c.providerId))],
      db,
    );
  }
  return res;
}

/**
 * Adds players. Before prices are published every player is added freely;
 * afterwards new players arrive unapproved and Ben approves them (spec section 2).
 * Existing players keep their position and price once published.
 */
export async function upsertPlayers(players: ProviderPlayer[], db: Db = pool()) {
  const published = (await getSetting<boolean>("prices_published", db)) === true;
  for (const p of players) {
    const club = await one<{ id: number }>("SELECT id FROM clubs WHERE provider_id = $1", [p.clubProviderId], db);
    if (!club) continue;
    await q(
      `INSERT INTO players (provider_id, club_id, name, position, season_goals, season_assists, season_minutes, approved)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8)
       ON CONFLICT (provider_id) DO UPDATE SET
         club_id = EXCLUDED.club_id, name = EXCLUDED.name,
         position = CASE WHEN players.published THEN players.position ELSE EXCLUDED.position END,
         season_goals = COALESCE(EXCLUDED.season_goals, players.season_goals),
         season_assists = COALESCE(EXCLUDED.season_assists, players.season_assists),
         season_minutes = COALESCE(EXCLUDED.season_minutes, players.season_minutes)`,
      [p.providerId, club.id, p.name, p.position, p.seasonGoals, p.seasonAssists, p.seasonMinutes, !published],
      db,
    );
  }
}

/** withStats: fetch season totals (for pricing; several calls per club). Otherwise one squad call per club. */
export async function syncCatalogue(provider: FootballProvider, db: Db = pool(), opts: { withStats?: boolean } = {}) {
  const clubs = await upsertClubs(provider, db);
  if (!clubs.ok) return { ok: false as const, error: clubs.error, calls: clubs.calls };
  const calls = [...clubs.calls];
  for (const c of clubs.data) {
    const res = opts.withStats ? await provider.getPlayers(c.providerId) : await provider.getSquad(c.providerId);
    calls.push(...res.calls);
    if (!res.ok) return { ok: false as const, error: res.error, calls };
    await upsertPlayers(res.data, db);
  }
  return { ok: true as const, calls };
}

async function clubId(providerId: string, db: Db) {
  return (await one<{ id: number }>("SELECT id FROM clubs WHERE provider_id = $1", [providerId], db))?.id ?? null;
}

/** Saves fixture headline data (kickoff, status, score). Returns our fixture id. */
export async function upsertFixture(f: ProviderFixture, db: Db = pool()): Promise<number | null> {
  const home = await clubId(f.homeClubProviderId, db);
  const away = await clubId(f.awayClubProviderId, db);
  if (!home || !away) return null;
  const started = LIVE.has(f.status) || FINISHED.has(f.status);
  // An abandoned match that is rescheduled is a replay: forget the void match's numbers
  // so the replay counts once, in the Week of its own kickoff.
  const prev = await one<{ id: number; status: string }>("SELECT id, status FROM fixtures WHERE provider_id = $1", [f.providerId], db);
  if (prev && VOID.has(prev.status) && !VOID.has(f.status)) {
    await q("DELETE FROM player_points WHERE fixture_id = $1", [prev.id], db);
    await q("DELETE FROM player_match_stats WHERE fixture_id = $1", [prev.id], db);
    await q("UPDATE fixtures SET started = false, week_number = NULL, finished_at = NULL, recheck_stage = 0, data_complete = false WHERE id = $1", [prev.id], db);
  }
  const row = await one<{ id: number }>(
    `INSERT INTO fixtures (provider_id, round_label, home_club_id, away_club_id, kickoff, status, minute, home_goals, away_goals, started, finished_at)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10, CASE WHEN $11::boolean THEN LEAST(now(), $5::timestamptz + interval '115 minutes') END)
     ON CONFLICT (provider_id) DO UPDATE SET
       round_label = EXCLUDED.round_label, kickoff = EXCLUDED.kickoff, status = EXCLUDED.status, minute = EXCLUDED.minute,
       home_goals = EXCLUDED.home_goals, away_goals = EXCLUDED.away_goals,
       started = fixtures.started OR EXCLUDED.started,
       finished_at = CASE WHEN $11::boolean THEN COALESCE(fixtures.finished_at, LEAST(now(), EXCLUDED.kickoff + interval '115 minutes')) ELSE NULL END
     RETURNING id`,
    [f.providerId, f.round, home, away, f.kickoff, f.status, f.minute, f.homeGoals, f.awayGoals, started, FINISHED.has(f.status)],
    db,
  );
  return row?.id ?? null;
}

/**
 * Updates the fixture list, Week deadlines (with the seven-day freeze) and which Week each match counts in.
 * Week 1 is the round chosen at launch (setting "launch_round").
 */
export async function syncFixtures(provider: FootballProvider, now: Date, db: Db = pool()) {
  const res = await provider.getFixtures();
  if (!res.ok) return res;
  for (const f of res.data) await upsertFixture(f, db);
  await refreshWeeks(res.data, now, db);
  return res;
}

export async function refreshWeeks(fixtures: ProviderFixture[], now: Date, db: Db = pool()) {
  const launchRound = (await getSetting<number>("launch_round", db)) ?? 1;
  const byRound = new Map<number, ProviderFixture[]>();
  for (const f of fixtures) {
    if (f.roundNumber === null || f.roundNumber < launchRound) continue;
    byRound.set(f.roundNumber, [...(byRound.get(f.roundNumber) ?? []), f]);
  }
  for (const [round, list] of [...byRound.entries()].sort((a, b) => a[0] - b[0])) {
    const number = round - launchRound + 1;
    const existing = await one<{ deadline: Date; frozen: boolean; locked: boolean }>("SELECT deadline, frozen, locked FROM weeks WHERE number = $1", [number], db);
    const current: WeekTiming | null = existing ? { number, deadline: existing.deadline, frozen: existing.frozen || existing.locked } : null;
    const next = nextDeadline(current, list, now);
    if (!next) continue;
    await q(
      `INSERT INTO weeks (number, round_label, deadline, frozen) VALUES ($1,$2,$3,$4)
       ON CONFLICT (number) DO UPDATE SET deadline = EXCLUDED.deadline, frozen = EXCLUDED.frozen, round_label = EXCLUDED.round_label`,
      [number, list[0].round, next.deadline, next.frozen],
      db,
    );
  }
  await assignWeeks(db);
}

/** Puts each match in the Week containing its actual kickoff (started matches keep their Week). */
export async function assignWeeks(db: Db = pool(), onlyFixtureId?: number) {
  const weeks = (await q<{ number: number; deadline: Date; frozen: boolean }>("SELECT number, deadline, frozen FROM weeks ORDER BY number", [], db)).map((w) => ({ number: w.number, deadline: w.deadline, frozen: w.frozen }));
  const fixtures = await q<{ id: number; kickoff: Date; status: string; started: boolean; week_number: number | null }>(
    "SELECT id, kickoff, status, started, week_number FROM fixtures WHERE $1::int IS NULL OR id = $1",
    [onlyFixtureId ?? null],
    db,
  );
  for (const f of fixtures) {
    const w = assignFixtureWeek({ kickoff: f.kickoff, status: f.status, started: f.started, currentWeek: f.week_number }, weeks);
    if (w !== f.week_number) await q("UPDATE fixtures SET week_number = $2 WHERE id = $1", [f.id, w], db);
  }
}

/** Stores a fetched match's headline data and player numbers. Returns the fixture id. */
export async function storeDetail(d: FixtureDetail, db: Db = pool()): Promise<{ fixtureId: number; newPlayers: number; corrections: number } | null> {
  const fixtureId = await upsertFixture(d.fixture, db);
  if (!fixtureId) return null;
  await q("UPDATE fixtures SET last_fetched = now() WHERE id = $1", [fixtureId], db);
  await assignWeeks(db, fixtureId);
  let newPlayers = 0;
  let corrections = 0;
  if (!d.players) return { fixtureId, newPlayers, corrections };
  // Once a match's points are final, changes are held for Ben's approval (spec section 4).
  const isFinal = !!(await one("SELECT 1 FROM player_points WHERE fixture_id = $1 AND status = 'final' LIMIT 1", [fixtureId], db));
  for (const line of d.players) {
    let player = await one<{ id: number; club_id: number }>("SELECT id, club_id FROM players WHERE provider_id = $1", [line.playerProviderId], db);
    const club = await clubId(line.clubProviderId, db);
    if (!club) continue;
    if (!player) {
      // Someone new (e.g. a signing): stored so points are kept, but unapproved until Ben adds them.
      if (!line.position) continue;
      player = await one<{ id: number; club_id: number }>(
        `INSERT INTO players (provider_id, club_id, name, position, approved) VALUES ($1,$2,$3,$4,false)
         ON CONFLICT (provider_id) DO UPDATE SET name = EXCLUDED.name RETURNING id, club_id`,
        [line.playerProviderId, club, line.playerName, line.position],
        db,
      );
      newPlayers++;
    }
    if (isFinal) {
      const prev = await one<Record<string, number | null>>(
        "SELECT minutes, goals, assists, saves, yellow, red, own_goals, pen_saved, pen_missed FROM player_match_stats WHERE fixture_id = $1 AND player_id = $2",
        [fixtureId, player!.id],
        db,
      );
      const next = { minutes: line.minutes, goals: line.goals, assists: line.assists, saves: line.saves, yellow: line.yellow, red: line.red, own_goals: line.ownGoals, pen_saved: line.penSaved, pen_missed: line.penMissed };
      const changed = !prev || Object.entries(next).some(([k, v]) => prev[k] !== v);
      if (changed) {
        const waiting = await one<{ new_stats: unknown }>("SELECT new_stats FROM corrections WHERE fixture_id = $1 AND player_id = $2 AND status = 'waiting'", [fixtureId, player!.id], db);
        if (!waiting || JSON.stringify(waiting.new_stats) !== JSON.stringify(next)) {
          await q("DELETE FROM corrections WHERE fixture_id = $1 AND player_id = $2 AND status = 'waiting'", [fixtureId, player!.id], db);
          await q(
            "INSERT INTO corrections (fixture_id, player_id, old_stats, new_stats, old_points, new_points) VALUES ($1,$2,$3,$4,0,0)",
            [fixtureId, player!.id, JSON.stringify(prev ?? {}), JSON.stringify(next)],
            db,
          );
          corrections++;
        }
      }
      continue;
    }
    await q(
      `INSERT INTO player_match_stats (fixture_id, player_id, club_id, minutes, goals, assists, saves, yellow, red, own_goals, pen_saved, pen_missed, updated_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12, now())
       ON CONFLICT (fixture_id, player_id) DO UPDATE SET
         club_id = EXCLUDED.club_id, minutes = EXCLUDED.minutes, goals = EXCLUDED.goals, assists = EXCLUDED.assists, saves = EXCLUDED.saves,
         yellow = EXCLUDED.yellow, red = EXCLUDED.red, own_goals = EXCLUDED.own_goals, pen_saved = EXCLUDED.pen_saved, pen_missed = EXCLUDED.pen_missed,
         updated_at = now()`,
      [fixtureId, player!.id, club, line.minutes, line.goals, line.assists, line.saves, line.yellow, line.red, line.ownGoals, line.penSaved, line.penMissed],
      db,
    );
  }
  return { fixtureId, newPlayers, corrections };
}
