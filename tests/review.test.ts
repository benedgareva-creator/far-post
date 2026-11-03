// Regression tests for the problems found in the code review (2026-11-03), one block per finding.
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { addClub, addPlayer, addUser, at, closeDb, resetDb } from "./helpers/db";
import { getSetting, one, q, setSetting } from "@/lib/db";
import { createSquad, lockDueWeeks, makeTransfers, saveLineup } from "@/lib/services/teams";
import { assignWeeks, storeDetail, upsertFixture } from "@/lib/services/sync";
import { playerWeekFixtures, rescoreFixture, rescoreWeek } from "@/lib/services/scoring";
import { decideCorrection, exportBackup, setLaunchRound, waitingCorrections } from "@/lib/services/admin";
import { nextDeadline } from "@/lib/game/weeks";
import { requestLoginLink, inviteEmails } from "@/lib/auth";
import { emailAllowed, ALERT_RESERVE_DAY } from "@/lib/email";
import { raiseAlert, retryAlertEmails } from "@/lib/services/alerts";
import { standings, myLeagues } from "@/lib/services/views";
import { fmtDate } from "@/components/StatusPill";
import { Poller } from "@/poller/poller";
import type { CallMeta, FixtureDetail, FootballProvider, ProviderFixture, ProviderPlayerLine, ProviderResult } from "@/lib/provider/types";

const P: Record<string, number> = {};
const C: number[] = [];

beforeAll(async () => {
  await resetDb();
  for (let c = 0; c < 6; c++) C.push(await addClub(`R${c}`));
  const shape: [string, number][] = [["GK", 2], ["DEF", 5], ["MID", 5], ["FWD", 3]];
  for (let c = 0; c < 6; c++) for (const [pos, n] of shape) for (let i = 0; i < n; i++) P[`${pos}${c}_${i}`] = await addPlayer(`${pos}${c}_${i}`, C[c], pos, pos === "GK" ? 4 : 6);
  await q("INSERT INTO weeks (number, deadline) VALUES (1, '2026-08-08T11:30:00Z'), (2, '2026-08-15T11:30:00Z'), (3, '2026-08-22T11:30:00Z')");
});
afterAll(closeDb);

/** 2 GK, 4 DEF, 5 MID, 3 FWD from clubs 0-4, at most 3 per club. */
function squad(): number[] {
  return [P.GK0_0, P.GK1_0, P.DEF0_0, P.DEF1_0, P.DEF2_0, P.DEF3_0, P.MID0_0, P.MID1_0, P.MID2_0, P.MID3_0, P.MID4_0, P.FWD2_0, P.FWD3_0, P.FWD4_0];
}
async function lineup(userId: number, week: number | null) {
  return q<{ player_id: number; slot: number; is_captain: boolean }>(
    "SELECT player_id, slot, is_captain FROM picks WHERE user_id = $1 AND week_number IS NOT DISTINCT FROM $2 ORDER BY slot",
    [userId, week],
  );
}

describe("1. edits after a deadline never leak into the Week that just closed", () => {
  it("snapshots the overdue Week before changing the editable team", async () => {
    const u = await addUser("leak@x.test");
    await createSquad(u, squad(), at("2026-08-01T00:00:00Z"));
    const before = await lineup(u, null);
    const captainBefore = before.find((p) => p.is_captain)!.player_id;
    // 11:31, the poller has not locked Week 1 yet. The manager edits for Week 2.
    const after = at("2026-08-08T11:31:00Z");
    const entries = before.map((p) => ({ playerId: p.player_id, slot: p.slot, isCaptain: p.slot === 11, isVice: p.slot === 10 }));
    await saveLineup(u, entries, after);
    await makeTransfers(u, [{ out: P.MID0_0, in: P.MID5_0 }], after);
    // The poller now locks Week 1: it must hold the team as it was at the deadline.
    await lockDueWeeks(at("2026-08-08T11:35:00Z"));
    const w1 = await lineup(u, 1);
    expect(w1).toHaveLength(14);
    expect(w1.find((p) => p.is_captain)!.player_id).toBe(captainBefore);
    expect(w1.map((p) => p.player_id)).toContain(P.MID0_0);
    expect(w1.map((p) => p.player_id)).not.toContain(P.MID5_0);
    // And the editable team has the changes for Week 2.
    expect((await lineup(u, null)).map((p) => p.player_id)).toContain(P.MID5_0);
  });
});

describe("2. a lineup save cannot bring back a player who was just sold", () => {
  it("keeps squad and lineup in step when a save and a transfer race", async () => {
    const u = await addUser("race@x.test", 2);
    await q("UPDATE users SET joined_week = NULL WHERE id = $1", [u]);
    const t = at("2026-08-09T00:00:00Z");
    await createSquad(u, squad(), t);
    for (let round = 0; round < 4; round++) {
      const lu = await lineup(u, null);
      const entries = lu.map((p) => ({ playerId: p.player_id, slot: p.slot, isCaptain: p.is_captain, isVice: !p.is_captain && p.slot === 10 }));
      const sell = lu.find((p) => p.slot === 7)!.player_id; // a midfielder
      const owned = new Set(lu.map((p) => p.player_id));
      const buy = [P.MID5_0, P.MID5_1, P.MID5_2, P.MID5_3, P.MID5_4].find((id) => !owned.has(id))!;
      await Promise.allSettled([saveLineup(u, entries, t), makeTransfers(u, [{ out: sell, in: buy }], t)]);
      const squadIds = (await q<{ player_id: number }>("SELECT player_id FROM squad_players WHERE user_id = $1", [u])).map((r) => r.player_id).sort();
      const pickIds = (await lineup(u, null)).map((p) => p.player_id).sort();
      expect(pickIds).toEqual(squadIds);
    }
  });
});

describe("3. missing match data is not treated as 'did not play'", () => {
  it("keeps participation unknown until the player's club list arrives", async () => {
    const f = await one<{ id: number }>(
      "INSERT INTO fixtures (provider_id, home_club_id, away_club_id, kickoff, week_number, status, started) VALUES ('M3', $1, $2, '2026-08-22T14:00:00Z', 3, 'FT', true) RETURNING id",
      [C[0], C[5]],
    );
    // Only the away club's numbers have arrived.
    await q("INSERT INTO player_match_stats (fixture_id, player_id, club_id, minutes) VALUES ($1, $2, $3, 90)", [f!.id, P.FWD5_0, C[5]]);
    let map = await playerWeekFixtures(3, [P.MID0_1]);
    expect(map.get(P.MID0_1)![0]).toMatchObject({ resolved: false, pending: true });
    // The home club's list arrives without this player: now we know they did not play.
    await q("INSERT INTO player_match_stats (fixture_id, player_id, club_id, minutes) VALUES ($1, $2, $3, 90)", [f!.id, P.MID0_0, C[0]]);
    map = await playerWeekFixtures(3, [P.MID0_1]);
    expect(map.get(P.MID0_1)![0]).toMatchObject({ resolved: true, minutes: 0, pending: false });
    await q("DELETE FROM fixtures WHERE id = $1", [f!.id]);
  });

  it("does not finalise a match while one club's list is missing", async () => {
    const f = await one<{ id: number }>(
      "INSERT INTO fixtures (provider_id, home_club_id, away_club_id, kickoff, week_number, status, started, finished_at) VALUES ('M3b', $1, $2, '2026-08-22T14:00:00Z', 3, 'FT', true, '2026-08-22T16:00:00Z') RETURNING id",
      [C[1], C[5]],
    );
    await q("INSERT INTO player_match_stats (fixture_id, player_id, club_id, minutes, goals, assists, saves, yellow, red, own_goals, pen_saved, pen_missed) VALUES ($1, $2, $3, 90, 0,0,0,0,0,0,0,0)", [f!.id, P.FWD1_0, C[1]]);
    await rescoreFixture(f!.id, at("2026-08-27T00:00:00Z"));
    const s = await one<{ status: string }>("SELECT status FROM player_points WHERE fixture_id = $1", [f!.id]);
    expect(s!.status).toBe("provisional");
    await q("DELETE FROM fixtures WHERE id = $1", [f!.id]);
  });
});

// A scripted supplier for the poller tests: each test decides what the next replies are.
class FakeSupplier implements FootballProvider {
  readonly name = "fake";
  readonly batchSize = 20;
  throttle?: () => Promise<void>;
  onCall?: (m: CallMeta) => Promise<void>;
  details: (ids: string[]) => FixtureDetail[] = () => [];
  next: Partial<CallMeta> = {};
  callsMade = 0;
  fixtures: ProviderFixture[] = [];
  callsForLiveFetch(n: number) { return Math.ceil(n / 20); }
  private async call<T>(endpoint: string, data: T): Promise<ProviderResult<T>> {
    if (this.throttle) await this.throttle();
    this.callsMade++;
    const meta: CallMeta = { endpoint, httpStatus: 200, ok: true, dayLimit: 7500, dayRemaining: 7000, minuteLimit: 300, minuteRemaining: 299, ...this.next };
    if (this.onCall) await this.onCall(meta);
    return meta.ok ? { ok: true, data, calls: [meta] } : { ok: false, error: meta.error ?? "failed", calls: [meta] };
  }
  getClubs() { return this.call("teams", C.map((_, i) => ({ providerId: `R${i}`, name: `Club R${i}`, shortName: `R${i}` }))); }
  getPlayers() { return this.call("players", []); }
  getSquad() { return this.call("squad", []); }
  getFixtures() { return this.call("fixtures", this.fixtures); }
  getFixtureDetails(ids: string[]) { return this.call(`fixtures?ids=${ids.join("-")}`, this.details(ids)); }
  getAccountStatus() { return this.call("status", { plan: "Pro", expires: null, active: true, requestsToday: 0, dayLimit: 7500 }); }
}

const line = (pid: string, club: string, s: Partial<ProviderPlayerLine> = {}): ProviderPlayerLine => ({
  playerProviderId: pid, clubProviderId: club, playerName: pid, position: null,
  minutes: 90, goals: 0, assists: 0, saves: 0, yellow: 0, red: 0, ownGoals: 0, penSaved: 0, penMissed: 0, ...s,
});
const fx = (id: string, home: string, away: string, kickoff: string, status: string, hg: number | null = 0, ag: number | null = 0): ProviderFixture => ({
  providerId: id, round: "Regular Season - 3", roundNumber: 3, homeClubProviderId: home, awayClubProviderId: away,
  kickoff: at(kickoff), status, minute: null, homeGoals: hg, awayGoals: ag,
});

describe("4. rechecks count only for matches that came back complete", () => {
  it("retries a match left out of the reply, and keeps retrying one still incomplete after 72 hours", async () => {
    const fid = (await upsertFixture(fx("M4", "R2", "R3", "2026-08-22T14:00:00Z", "FT")))!;
    await assignWeeks(undefined, fid);
    await q("UPDATE fixtures SET finished_at = '2026-08-22T16:00:00Z' WHERE id = $1", [fid]);
    let clock = at("2026-08-25T17:00:00Z"); // 73 hours after full time
    await setSetting("poller_daily_done", clock.toISOString().slice(0, 10));
    const sup = new FakeSupplier();
    const poller = new Poller({ provider: sup, now: () => clock, sleep: async () => {}, log: () => {}, limits: { day: 7500, minute: 300 } });
    // The supplier leaves the match out of its reply: the stage must not move.
    sup.details = () => [];
    await poller.tick();
    let row = await one<{ recheck_stage: number; retry_after: Date | null }>("SELECT recheck_stage, retry_after FROM fixtures WHERE id = $1", [fid]);
    expect(row!.recheck_stage).toBe(0);
    expect(row!.retry_after).not.toBeNull();
    // 15 minutes later it comes back, but saves are still blank: stage 3, retried in 6 hours, Ben alerted.
    clock = new Date(clock.getTime() + 16 * 60_000);
    sup.details = () => [{ fixture: fx("M4", "R2", "R3", "2026-08-22T14:00:00Z", "FT"), players: [line("GK2_0", "R2", { saves: null }), line("GK3_0", "R3")] }];
    await poller.tick();
    row = await one("SELECT recheck_stage, retry_after FROM fixtures WHERE id = $1", [fid]);
    expect(row!.recheck_stage).toBe(3);
    expect(row!.retry_after!.getTime()).toBeGreaterThan(clock.getTime() + 5 * 3600_000);
    expect(await one("SELECT 1 FROM alerts WHERE kind = $1 AND resolved_at IS NULL", [`incomplete-${fid}`])).not.toBeNull();
    // 6 hours later the blank is filled: points become final and the alert clears.
    clock = new Date(clock.getTime() + 6 * 3600_000 + 60_000);
    sup.details = () => [{ fixture: fx("M4", "R2", "R3", "2026-08-22T14:00:00Z", "FT"), players: [line("GK2_0", "R2", { saves: 3 }), line("GK3_0", "R3")] }];
    await poller.tick();
    const fin = await one<{ s: string }>("SELECT string_agg(DISTINCT status, ',') AS s FROM player_points WHERE fixture_id = $1", [fid]);
    expect(fin!.s).toBe("final");
    expect(await one("SELECT 1 FROM alerts WHERE kind = $1 AND resolved_at IS NULL", [`incomplete-${fid}`])).toBeNull();
  });
});

describe("5. a changed final score is held for approval and fully applied", () => {
  it("raises a score correction, keeps the old score, then updates clean sheets and team totals on approval", async () => {
    const fid = (await one<{ id: number }>("SELECT id FROM fixtures WHERE provider_id = 'M4'"))!.id;
    const gk = async () => (await one<{ points: number; status: string }>("SELECT points, status FROM player_points WHERE fixture_id = $1 AND player_id = $2", [fid, P.GK2_0]))!;
    expect(await gk()).toMatchObject({ points: 2 + 5, status: "final" }); // clean sheet
    // The supplier changes the result from 0-0 to 0-1; R2's keeper's own numbers are unchanged.
    await storeDetail({ fixture: fx("M4", "R2", "R3", "2026-08-22T14:00:00Z", "FT", 0, 1), players: [line("GK2_0", "R2", { saves: 3 }), line("GK3_0", "R3")] });
    expect(await one("SELECT home_goals, away_goals FROM fixtures WHERE id = $1", [fid])).toMatchObject({ home_goals: 0, away_goals: 0 });
    const waiting = (await waitingCorrections()).filter((c) => c.fixture_id === fid);
    expect(waiting).toHaveLength(1);
    expect(waiting[0].kind).toBe("score");
    expect(waiting[0].affected.find((a) => a.name === "GK2_0")).toMatchObject({ oldPoints: 7, newPoints: 2 });
    // A team that had the keeper sees its total change with the approval.
    const u = await addUser("cs@x.test", 3);
    const sq = [P.GK2_0, P.GK1_1, P.DEF0_1, P.DEF1_1, P.DEF2_1, P.DEF3_1, P.MID0_1, P.MID1_1, P.MID2_1, P.MID3_1, P.MID4_1, P.FWD0_1, P.FWD1_1, P.FWD4_1];
    const slots = [1, 12, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 13, 14];
    for (let i = 0; i < 14; i++) await q("INSERT INTO picks (user_id, week_number, player_id, slot, is_captain, is_vice, price) VALUES ($1, 3, $2, $3, $4, $5, 6)", [u, sq[i], slots[i], i === 0, i === 2]);
    await rescoreWeek(3);
    const before = (await one<{ points: number }>("SELECT points FROM team_week_points WHERE user_id = $1 AND week_number = 3", [u]))!.points;
    const admin = await addUser("ben@example.com");
    await decideCorrection(admin, waiting[0].id, true);
    expect(await one("SELECT home_goals, away_goals FROM fixtures WHERE id = $1", [fid])).toMatchObject({ home_goals: 0, away_goals: 1 });
    expect(await gk()).toMatchObject({ points: 2, status: "final" });
    const after = (await one<{ points: number }>("SELECT points FROM team_week_points WHERE user_id = $1 AND week_number = 3", [u]))!.points;
    expect(after).toBe(before - 5 * 2); // captain: clean sheet lost, doubled
  });
});

describe("6. a match first seen live counts in the Week of its actual kickoff", () => {
  it("does not keep a Week guessed while the match was only scheduled", async () => {
    const id = (await upsertFixture(fx("M6", "R0", "R1", "2026-08-08T14:00:00Z", "NS")))!;
    await assignWeeks(undefined, id);
    expect((await one<{ week_number: number }>("SELECT week_number FROM fixtures WHERE id = $1", [id]))!.week_number).toBe(1);
    // Moved into Week 2; the next update we see is already in play.
    await upsertFixture(fx("M6", "R0", "R1", "2026-08-16T14:00:00Z", "1H"));
    await assignWeeks(undefined, id);
    expect((await one<{ week_number: number; week_fixed: boolean }>("SELECT week_number, week_fixed FROM fixtures WHERE id = $1", [id]))).toMatchObject({ week_number: 2, week_fixed: true });
    // Suspended and resumed later: it stays in Week 2.
    await upsertFixture(fx("M6", "R0", "R1", "2026-08-23T14:00:00Z", "2H"));
    await assignWeeks(undefined, id);
    expect((await one<{ week_number: number }>("SELECT week_number FROM fixtures WHERE id = $1", [id]))!.week_number).toBe(2);
    await q("DELETE FROM fixtures WHERE id = $1", [id]);
  });
});

describe("7. supplier stops and budgets apply to every single request", () => {
  async function poller(sup: FakeSupplier, clock: () => Date) {
    return new Poller({ provider: sup, now: clock, sleep: async () => {}, log: () => {}, limits: { day: 7500, minute: 300 } });
  }
  it("stops the rest of the pass the moment the supplier blocks us", async () => {
    await q("DELETE FROM settings WHERE key IN ('poller_daily_done', 'poller_blocked', 'poller_day_stop')");
    const sup = new FakeSupplier();
    sup.next = { ok: false, blocked: true, httpStatus: 403, error: "access: suspended" };
    const p = await poller(sup, () => at("2026-09-01T10:00:00Z"));
    const did = await p.tick();
    expect(sup.callsMade).toBe(1); // squads refused: nothing else was tried
    expect(did.join(" ")).toMatch(/stopped: blocked/);
    await q("DELETE FROM settings WHERE key = 'poller_blocked'");
  });

  it("stops everything until midnight UTC when the day's allowance is used up", async () => {
    const sup = new FakeSupplier();
    sup.next = { ok: false, dayExhausted: true, dayLimit: null, dayRemaining: null, error: "requests: limit reached" };
    let now = at("2026-09-02T10:00:00Z");
    const p = await poller(sup, () => now);
    await p.tick();
    expect(await getSetting("poller_day_stop")).toBe("2026-09-02");
    sup.next = {};
    const made = sup.callsMade;
    now = at("2026-09-02T12:00:00Z");
    expect(await p.tick()).toContain("day allowance used up");
    expect(sup.callsMade).toBe(made); // no retries the same day, whatever the headers said
    now = at("2026-09-03T00:05:00Z");
    await p.tick();
    expect(await getSetting("poller_day_stop")).toBeNull();
    expect(sup.callsMade).toBeGreaterThan(made);
  });

  it("keeps the last 10% of the day for live points and corrections", async () => {
    await q("DELETE FROM settings WHERE key = 'poller_daily_done'");
    const day = "2026-09-04";
    await q("INSERT INTO api_requests (at, utc_day, endpoint, purpose, ok) SELECT $1, $2, 'x', 'live', true FROM generate_series(1, 6800)", [at(`${day}T09:00:00Z`), day]);
    const sup = new FakeSupplier();
    const p = await poller(sup, () => at(`${day}T10:00:00Z`));
    await p.tick();
    // Squads and the fixture list are background work: refused at 90%. Corrections still run.
    const purposes = (await q<{ purpose: string }>("SELECT DISTINCT purpose FROM api_requests WHERE utc_day = $1 AND endpoint <> 'x'", [day])).map((r) => r.purpose);
    expect(purposes).not.toContain("background");
    expect(await getSetting("poller_daily_done")).not.toBe(day);
    await q("DELETE FROM api_requests WHERE endpoint = 'x'");
  });
});

describe("8. only invited emails can join", () => {
  it("refuses a sign-in link to an email nobody invited, and allows it once invited", async () => {
    const refused = await requestLoginLink("stranger@x.test", "1.2.3.4");
    expect(refused.ok).toBe(false);
    expect(refused.message).toMatch(/invite-only/);
    expect(await one("SELECT 1 FROM login_tokens WHERE email = 'stranger@x.test'")).toBeNull();
    const admin = (await one<{ id: number }>("SELECT id FROM users WHERE email = 'ben@example.com'"))!.id;
    const r = await inviteEmails(admin, "Stranger@x.test, not-an-email");
    expect(r.invited).toEqual(["stranger@x.test"]);
    expect(r.skipped).toEqual(["not-an-email"]);
    expect((await requestLoginLink("stranger@x.test", "1.2.3.4")).ok).toBe(true);
    expect((await requestLoginLink("leak@x.test", "1.2.3.4")).ok).toBe(true); // existing players can always sign in
  });

  it("cannot be pushed past the hourly limit by many requests at once", async () => {
    const admin = (await one<{ id: number }>("SELECT id FROM users WHERE email = 'ben@example.com'"))!.id;
    await inviteEmails(admin, "burst@x.test");
    const results = await Promise.all(Array.from({ length: 12 }, () => requestLoginLink("burst@x.test", "9.9.9.9")));
    expect(results.filter((r) => r.ok)).toHaveLength(5);
  });
});

describe("9. the seven-day freeze cannot be skipped by a schedule change", () => {
  it("fixes the stored deadline once it is within seven days, even if the round moved later", () => {
    const stored = { number: 5, deadline: at("2026-09-12T10:30:00Z"), frozen: false };
    const moved = [{ kickoff: at("2026-09-19T11:30:00Z"), status: "NS" }];
    const r = nextDeadline(stored, moved, at("2026-09-05T12:00:00Z"))!; // 6 days 22.5 hours before
    expect(r).toEqual({ deadline: stored.deadline, frozen: true });
  });
});

describe("10. a real-data launch can be set up from Admin", () => {
  it("chooses the launch round only before any Week has locked", async () => {
    const admin = (await one<{ id: number }>("SELECT id FROM users WHERE email = 'ben@example.com'"))!.id;
    await expect(setLaunchRound(admin, 8)).rejects.toThrow(/already locked/);
  });

  it("loads clubs before the fixture list, so a fresh database gets its matches on the first run", async () => {
    await q("DELETE FROM settings WHERE key = 'poller_daily_done'");
    const sup = new FakeSupplier();
    await q("UPDATE clubs SET provider_id = provider_id || '-old'");
    sup.fixtures = [fx("NEW1", "R0", "R1", "2026-09-26T14:00:00Z", "NS")];
    const p = new Poller({ provider: sup, now: () => at("2026-09-05T10:00:00Z"), sleep: async () => {}, log: () => {}, limits: { day: 7500, minute: 300 } });
    const did = await p.dailyJobs(at("2026-09-05T10:00:00Z"));
    expect(did).toContain("fixture list");
    expect(await one("SELECT 1 FROM fixtures WHERE provider_id = 'NEW1'")).not.toBeNull();
  });
});

describe("11. backups are one consistent snapshot", () => {
  it("exports every table, including invitations", async () => {
    const b = await exportBackup();
    expect(b.version).toBe(2);
    expect(b.tables.invites.length).toBeGreaterThan(0);
    expect(b.tables.players.length).toBeGreaterThan(0);
  });
});

describe("14. times say which time zone they are in", () => {
  it("labels GMT and BST", () => {
    expect(fmtDate(at("2026-08-14T18:00:00Z"))).toMatch(/19:00 BST/);
    expect(fmtDate(at("2026-12-14T18:00:00Z"))).toMatch(/18:00 GMT/);
  });
});

describe("15. the email allowance protects alerts", () => {
  it("stops sign-in emails before the limit but still sends alerts", async () => {
    await q("DELETE FROM email_log");
    await q("INSERT INTO email_log (kind, ok) SELECT 'login', true FROM generate_series(1, $1)", [100 - ALERT_RESERVE_DAY]);
    expect(await emailAllowed("login")).toBe(false);
    expect(await emailAllowed("alert")).toBe(true);
    await q("DELETE FROM email_log");
  });

  it("retries an alert email that failed", async () => {
    await q("INSERT INTO email_log (kind, ok) SELECT 'login', true FROM generate_series(1, 100)");
    await raiseAlert("test-retry", "warning", "Something needs a look");
    expect(await one("SELECT emailed, email_attempts FROM alerts WHERE kind = 'test-retry'")).toMatchObject({ emailed: false, email_attempts: 1 });
    await q("DELETE FROM email_log");
    await retryAlertEmails();
    expect(await one("SELECT emailed, email_attempts FROM alerts WHERE kind = 'test-retry'")).toMatchObject({ emailed: true, email_attempts: 2 });
  });
});

describe("16. tied teams get the same rank everywhere", () => {
  it("shares a rank in the table and on the league card", async () => {
    const a = await addUser("tie-a@x.test"), b = await addUser("tie-b@x.test"), c = await addUser("tie-c@x.test");
    const l = (await one<{ id: number }>("INSERT INTO leagues (name, code, owner_id, start_week) VALUES ('Ties', 'TIES0001', $1, 1) RETURNING id", [a]))!.id;
    for (const [u, pts] of [[a, 50], [b, 50], [c, 40]]) {
      await q("INSERT INTO league_members (league_id, user_id) VALUES ($1, $2)", [l, u]);
      await q("INSERT INTO team_week_points (user_id, week_number, points, detail, status) VALUES ($1, 1, $2, '{}', 'final') ON CONFLICT (user_id, week_number) DO UPDATE SET points = EXCLUDED.points", [u, pts]);
    }
    const table = await standings(l, null);
    expect(table.map((t) => [t.rank, t.tied])).toEqual([["1", true], ["1", true], ["3", false]]);
    const cardB = (await myLeagues(b)).find((x) => x.id === l)!;
    expect(cardB).toMatchObject({ rank: "1", tied: true });
  });
});

