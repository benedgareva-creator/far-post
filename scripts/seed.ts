// Sets up the made-up demo league with a few friendly teams, so every page has
// something to show before any subscription. Run: `npm run db:seed`.
// Pass --reset to wipe game data first. Real-data setup uses Admin pages instead.
import "./env";
import { config } from "../src/lib/config";
import { getSetting, pool, q, setSetting } from "../src/lib/db";
import { getProvider } from "../src/lib/provider";
import { MOCK_SLOTS_MINUTES } from "../src/lib/provider/mock";
import { storeDetail, syncCatalogue, syncFixtures } from "../src/lib/services/sync";
import { rescoreFixture, rescoreWeek } from "../src/lib/services/scoring";
import { lockDueWeeks } from "../src/lib/services/teams";
import { publishPrices } from "../src/lib/services/admin";
import { defaultLineup, validateSquad, type Position, type SquadPlayer } from "../src/lib/game/rules";
import { now as gameNow } from "../src/lib/clock";

const LAUNCH_ROUND = 8; // Week 1 = round 8 of the demo season (a mid-season start)
const CURRENT_ROUND = 10; // "now" is during round 10's 15:00 matches = Week 3

export async function seed(opts: { reset?: boolean; minutesIntoRound?: number } = {}) {
  const db = pool();
  if (config.provider !== "mock") throw new Error("The demo seed only runs with FOOTBALL_PROVIDER=mock.");
  if (opts.reset) {
    await q(`TRUNCATE corrections, team_week_points, player_points, player_match_stats, transfers, picks, squad_players,
             league_members, leagues, fixtures, weeks, rulesets, players, clubs, api_requests, alerts, admin_log, sessions, login_tokens, users, settings RESTART IDENTITY CASCADE`);
  }
  if (await getSetting("mock_anchor")) {
    console.log("Demo league already set up (use --reset to start again).");
    return;
  }
  // Place the season so that "now" is ~50 minutes into round 10's 15:00 kickoffs.
  const minutesIn = opts.minutesIntoRound ?? MOCK_SLOTS_MINUTES[1] + 50;
  const anchor = new Date(Date.now() - (CURRENT_ROUND - 1) * 7 * 86400_000 - minutesIn * 60_000);
  await setSetting("mock_anchor", anchor.toISOString());
  await setSetting("launch_round", LAUNCH_ROUND);
  const now = await gameNow();
  const provider = await getProvider();

  console.log("Loading clubs, players and fixtures...");
  const cat = await syncCatalogue(provider, db, { withStats: true });
  if (!cat.ok) throw new Error(cat.error);
  const fx = await syncFixtures(provider, now);
  if (!fx.ok) throw new Error(fx.error);

  console.log("Suggesting and publishing prices...");
  await publishPrices(null, { useSuggestions: true });

  console.log("Creating demo teams...");
  const adminEmail = config.adminEmails[0] ?? "ben@example.com";
  const names: [string, string][] = [
    [adminEmail, "Ben's Back Post"],
    ["sam@example.com", "Sam's Sweepers"],
    ["priya@example.com", "Priya's Press"],
    ["tom@example.com", "Tom's Tiki-Taka"],
    ["ana@example.com", "Ana's Overlap"],
    ["joe@example.com", "Joe's Long Ball"],
    ["mei@example.com", "Mei's Midfield"],
    ["olu@example.com", "Olu's Offside Trap"],
  ];
  const players = await q<{ id: number; position: Position; club_id: number; price: number }>("SELECT id, position, club_id, price FROM players WHERE published");
  const userIds: number[] = [];
  let seedN = 1;
  const rand = () => {
    seedN = (seedN * 16807) % 2147483647;
    return seedN / 2147483647;
  };
  for (const [email, team] of names) {
    const user = await q<{ id: number }>(
      "INSERT INTO users (email, team_name, is_admin, joined_week) VALUES ($1,$2,$3,1) RETURNING id",
      [email.toLowerCase(), team, email.toLowerCase() === adminEmail.toLowerCase()],
    );
    const id = user[0].id;
    userIds.push(id);
    const squad = randomSquad(players, rand);
    for (const p of squad) await q("INSERT INTO squad_players (user_id, player_id, purchase_price) VALUES ($1,$2,$3)", [id, p.id, p.price]);
    const lineup = defaultLineup(squad);
    for (const e of lineup) {
      await q("INSERT INTO picks (user_id, week_number, player_id, slot, is_captain, is_vice, price) VALUES ($1,NULL,$2,$3,$4,$5,$6)", [id, e.playerId, e.slot, e.isCaptain, e.isVice, squad.find((p) => p.id === e.playerId)!.price]);
    }
  }
  const league = await q<{ id: number }>("INSERT INTO leagues (name, code, owner_id, start_week) VALUES ('Friends of the Far Post', 'FARPOST1', $1, 1) RETURNING id", [userIds[0]]);
  for (const id of userIds) await q("INSERT INTO league_members (league_id, user_id) VALUES ($1,$2)", [league[0].id, id]);

  console.log("Locking past Weeks and scoring them...");
  await lockDueWeeks(now);
  const started = await q<{ id: number; provider_id: string; finished_at: Date | null }>("SELECT id, provider_id, finished_at FROM fixtures WHERE week_number IS NOT NULL AND kickoff <= $1 ORDER BY kickoff", [now]);
  for (let i = 0; i < started.length; i += 20) {
    const res = await provider.getFixtureDetails(started.slice(i, i + 20).map((f) => f.provider_id));
    if (!res.ok) throw new Error(res.error);
    for (const d of res.data) {
      const s = await storeDetail(d);
      if (s) await rescoreFixture(s.fixtureId, now);
    }
  }
  // Old matches have already had their rechecks.
  await q("UPDATE fixtures SET recheck_stage = 3 WHERE finished_at < $1::timestamptz - interval '72 hours'", [now]);
  await q("UPDATE fixtures SET recheck_stage = 2 WHERE finished_at >= $1::timestamptz - interval '72 hours' AND finished_at < $1::timestamptz - interval '24 hours'", [now]);
  await q("UPDATE fixtures SET recheck_stage = 1 WHERE finished_at >= $1::timestamptz - interval '24 hours' AND finished_at < $1::timestamptz - interval '30 minutes'", [now]);
  const weeks = await q<{ number: number }>("SELECT number FROM weeks WHERE locked ORDER BY number");
  for (const w of weeks) await rescoreWeek(w.number);
  await setSetting("last_success", now);
  await setSetting("poller_daily_done", now.toISOString().slice(0, 10));
  console.log(`Done. Demo league ready: Week ${weeks.length} is live. Sign in as ${adminEmail} (admin).`);
}

function randomSquad(players: { id: number; position: Position; club_id: number; price: number }[], rand: () => number): SquadPlayer[] {
  const shape: [Position, number][] = [["GK", 2], ["DEF", 4], ["MID", 5], ["FWD", 3]];
  for (let attempt = 0; attempt < 5000; attempt++) {
    const picked: SquadPlayer[] = [];
    for (const [pos, n] of shape) {
      const pool = players.filter((p) => p.position === pos && !picked.some((x) => x.id === p.id));
      while (picked.filter((p) => p.position === pos).length < n) {
        const p = pool.splice(Math.floor(rand() * pool.length), 1)[0];
        picked.push({ id: p.id, position: p.position, clubId: p.club_id, price: p.price });
      }
    }
    if (validateSquad(picked).length === 0) return picked;
  }
  throw new Error("Could not build a demo squad");
}

if (require.main === module) {
  seed({ reset: process.argv.includes("--reset") })
    .then(() => pool().end())
    .catch((e) => {
      console.error(e);
      process.exit(1);
    });
}
