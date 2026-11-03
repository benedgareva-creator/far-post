// Acceptance checks 2 and 3 (spec section 9).
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { addClub, addPlayer, addUser, at, closeDb, resetDb } from "./helpers/db";
import { one, q } from "@/lib/db";
import { createSquad, makeTransfers, saveLineup, lockDueWeeks, GameError, transferStatus } from "@/lib/services/teams";
import { storeDetail } from "@/lib/services/sync";
import { rescoreFixture, rescoreWeek } from "@/lib/services/scoring";
import { decideCorrection, publishDraftRules, saveDraftRules, waitingCorrections } from "@/lib/services/admin";
import { DEFAULT_RULES } from "@/lib/scoring/rules";
import type { ProviderPlayerLine } from "@/lib/provider/types";

const P: Record<string, number> = {};
let clubIds: number[] = [];
const T0 = at("2026-08-01T00:00:00Z");

beforeAll(async () => {
  await resetDb();
  clubIds = [];
  for (let c = 0; c < 8; c++) clubIds.push(await addClub(`K${c}`));
  // 8 clubs x (2 GK, 4 DEF, 5 MID, 3 FWD) players, mostly price 6; a few 10s.
  const shape: [string, number][] = [["GK", 2], ["DEF", 4], ["MID", 5], ["FWD", 3]];
  for (let c = 0; c < 8; c++) for (const [pos, n] of shape) for (let i = 0; i < n; i++) P[`${pos}${c}_${i}`] = await addPlayer(`${pos}${c}_${i}`, clubIds[c], pos, c === 7 ? 10 : pos === "GK" ? 4 : 6);
  await q("INSERT INTO weeks (number, deadline) VALUES (1, '2026-08-08T11:30:00Z'), (2, '2026-08-15T11:30:00Z'), (3, '2026-08-22T11:30:00Z')");
  await q("INSERT INTO fixtures (provider_id, home_club_id, away_club_id, kickoff, week_number, status) VALUES ('X1', $1, $2, '2026-08-08T12:30:00Z', 1, 'NS')", [clubIds[0], clubIds[1]]);
});
afterAll(closeDb);

/** A legal squad drawn from clubs 0-4: 2 GK, 4 DEF, 5 MID, 3 FWD, max 3 per club. Cost 8 + 72 = 80. */
function legalSquad(): number[] {
  return [
    P.GK0_0, P.GK1_0,
    P.DEF0_0, P.DEF1_0, P.DEF2_0, P.DEF3_0,
    P.MID0_0, P.MID1_0, P.MID2_0, P.MID3_0, P.MID4_0,
    P.FWD2_0, P.FWD3_0, P.FWD4_0,
  ];
}

describe("squads, transfers and deadlines", () => {
  it("creates a squad and rejects bad ones", async () => {
    const u = await addUser("a@x.test", null);
    await expect(createSquad(u, legalSquad().slice(1), T0)).rejects.toThrow(GameError);
    const fourFromClub0 = [P.GK0_0, P.GK1_0, P.DEF0_0, P.DEF0_1, P.DEF0_2, P.DEF3_0, P.MID0_0, P.MID1_0, P.MID2_0, P.MID3_0, P.MID4_0, P.FWD2_0, P.FWD3_0, P.FWD4_0];
    await expect(createSquad(u, fourFromClub0, T0)).rejects.toThrow(/at most 3/);
    await createSquad(u, legalSquad(), T0);
    const user = await one<{ joined_week: number }>("SELECT joined_week FROM users WHERE id = $1", [u]);
    expect(user!.joined_week).toBe(1);
    expect((await transferStatus(u, T0)).remaining).toBeNull(); // unlimited before first deadline
  });

  it("allows unlimited transfers before the first deadline, then two a week without carry-over", async () => {
    const u = await addUser("b@x.test", null);
    await createSquad(u, legalSquad(), T0);
    await makeTransfers(u, [{ out: P.MID0_0, in: P.MID5_0 }], T0);
    await makeTransfers(u, [{ out: P.MID1_0, in: P.MID5_1 }], T0);
    await makeTransfers(u, [{ out: P.MID2_0, in: P.MID6_0 }], T0);
    await lockDueWeeks(at("2026-08-08T12:00:00Z"));
    const wk2 = at("2026-08-09T00:00:00Z");
    expect((await transferStatus(u, wk2)).remaining).toBe(2);
    await expect(makeTransfers(u, [{ out: P.MID3_0, in: P.MID6_1 }, { out: P.MID4_0, in: P.MID6_2 }, { out: P.DEF0_0, in: P.DEF5_0 }], wk2)).rejects.toThrow(/only 2/);
    await makeTransfers(u, [{ out: P.MID3_0, in: P.MID6_1 }], wk2);
    expect((await transferStatus(u, wk2)).remaining).toBe(1);
    // Next Week: back to two, not three.
    await lockDueWeeks(at("2026-08-15T12:00:00Z"));
    expect((await transferStatus(u, at("2026-08-16T00:00:00Z"))).remaining).toBe(2);
  });

  it("rejects late edits, selling players you do not own, and position mismatches", async () => {
    const u = await addUser("c@x.test", null);
    await createSquad(u, legalSquad(), at("2026-08-16T00:00:00Z"));
    // Right after week 3's deadline nothing can change until week 4 exists.
    await expect(makeTransfers(u, [{ out: P.MID0_0, in: P.MID5_0 }], at("2026-08-22T11:30:01Z"))).rejects.toThrow(/no upcoming Week|deadline/i);
    await expect(makeTransfers(u, [{ out: P.MID5_3, in: P.MID5_0 }], at("2026-08-16T00:00:00Z"))).rejects.toThrow(/only sell players you own/);
    await expect(makeTransfers(u, [{ out: P.MID0_0, in: P.FWD5_0 }], at("2026-08-16T00:00:00Z"))).rejects.toThrow(/same position/);
    await expect(saveLineup(u, [], at("2026-08-22T12:00:00Z"))).rejects.toThrow(/no upcoming Week|deadline/i);
  });

  it("stops two simultaneous budget-breaking transfers from both succeeding", async () => {
    const u = await addUser("d@x.test", null);
    await createSquad(u, legalSquad(), at("2026-08-16T00:00:00Z")); // costs 80, bank 20
    const t = at("2026-08-16T00:00:00Z");
    // Each swap adds 4 (6 -> 10). Five such swaps = 100 exactly; we fire 6 at once in separate requests, cap is 5.
    const swaps = [
      { out: P.DEF0_0, in: P.DEF7_0 }, { out: P.DEF1_0, in: P.DEF7_1 }, { out: P.DEF2_0, in: P.DEF7_2 },
      { out: P.MID0_0, in: P.MID7_0 }, { out: P.MID1_0, in: P.MID7_1 }, { out: P.MID2_0, in: P.MID7_2 },
    ];
    const results = await Promise.allSettled(swaps.map((s) => makeTransfers(u, [s], t)));
    const spent = await one<{ s: string }>("SELECT sum(purchase_price) AS s FROM squad_players WHERE user_id = $1", [u]);
    expect(Number(spent!.s)).toBeLessThanOrEqual(100);
    const club7 = await one<{ n: string }>("SELECT count(*) AS n FROM squad_players s JOIN players p ON p.id = s.player_id WHERE s.user_id = $1 AND p.club_id = $2", [u, clubIds[7]]);
    expect(Number(club7!.n)).toBeLessThanOrEqual(3); // three-per-club also holds under concurrency
    expect(results.filter((r) => r.status === "rejected").length).toBeGreaterThan(0);
  });

  it("hides nothing it should not: lineups lock at the deadline and carry forward", async () => {
    const u = await addUser("e@x.test", null);
    await createSquad(u, legalSquad(), at("2026-08-16T00:00:00Z"));
    await lockDueWeeks(at("2026-08-22T12:00:00Z"));
    const locked = await one<{ n: string }>("SELECT count(*) AS n FROM picks WHERE user_id = $1 AND week_number = 3", [u]);
    expect(Number(locked!.n)).toBe(14);
  });
});

describe("live scoring, pending data, rule edits and corrections", () => {
  const ln = (pid: string, club: string, s: Partial<ProviderPlayerLine>): ProviderPlayerLine => ({
    playerProviderId: pid, clubProviderId: club, playerName: pid, position: null,
    minutes: 90, goals: 0, assists: 0, saves: 0, yellow: 0, red: 0, ownGoals: 0, penSaved: 0, penMissed: 0, ...s,
  });
  const fixture = (status: string, hg: number, ag: number) => ({
    providerId: "LIVE1", round: "Regular Season - 3", roundNumber: 3, homeClubProviderId: "K0", awayClubProviderId: "K1",
    kickoff: at("2026-08-22T14:00:00Z"), status, minute: null, homeGoals: hg, awayGoals: ag,
  });
  let fid = 0;
  const pts = async (pid: string) => (await one<{ points: number; status: string; pending: string[] }>("SELECT points, status, pending FROM player_points WHERE fixture_id = $1 AND player_id = $2", [fid, P[pid]]))!;

  it("updates staged minutes and removes a cancelled goal", async () => {
    let r = await storeDetail({ fixture: fixture("1H", 1, 0), players: [ln("FWD0_0", "K0", { minutes: 30, goals: 1 })] });
    fid = r!.fixtureId;
    await rescoreFixture(fid, at("2026-08-22T14:30:00Z"));
    expect(await pts("FWD0_0")).toMatchObject({ points: 1 + 5, status: "live" });
    // VAR cancels the goal; minutes move on.
    r = await storeDetail({ fixture: fixture("2H", 0, 0), players: [ln("FWD0_0", "K0", { minutes: 65, goals: 0 })] });
    await rescoreFixture(fid, at("2026-08-22T15:20:00Z"));
    expect((await pts("FWD0_0")).points).toBe(2);
  });

  it("keeps unknown numbers pending and finalises when blanks are resolved", async () => {
    await storeDetail({ fixture: fixture("FT", 0, 0), players: [ln("GK0_0", "K0", { saves: null }), ln("FWD0_0", "K0", {}), ln("GK1_0", "K1", {})] });
    await rescoreFixture(fid, at("2026-08-22T16:00:00Z"));
    const gk = await pts("GK0_0");
    expect(gk.pending).toEqual(["saves"]);
    expect(gk.status).toBe("provisional");
    // 72 hours later but still pending: not final.
    await q("UPDATE fixtures SET finished_at = '2026-08-22T16:00:00Z' WHERE id = $1", [fid]);
    await rescoreFixture(fid, at("2026-08-26T00:00:00Z"));
    expect((await pts("GK0_0")).status).toBe("provisional");
    // The supplier fills the blank: complete data, 72 hours passed -> final.
    await storeDetail({ fixture: fixture("FT", 0, 0), players: [ln("GK0_0", "K0", { saves: 4 }), ln("FWD0_0", "K0", {}), ln("GK1_0", "K1", {})] });
    await rescoreFixture(fid, at("2026-08-26T00:00:00Z"));
    expect(await pts("GK0_0")).toMatchObject({ points: 2 + 1 + 5, status: "final" });
  });

  it("never rescores past Weeks when rules change", async () => {
    await lockDueWeeks(at("2026-08-22T12:00:00Z"));
    const before = (await pts("GK0_0")).points;
    const rules = structuredClone(DEFAULT_RULES);
    rules.cleanSheet.points.GK = 10;
    const admin = await addUser("admin@x.test");
    await saveDraftRules(admin, "Bigger clean sheets", rules);
    await q("INSERT INTO weeks (number, deadline) VALUES (4, '2026-08-29T11:30:00Z')");
    const from = await publishDraftRules(admin, at("2026-08-26T00:00:00Z"));
    expect(from).toBe(4);
    await rescoreFixture(fid, at("2026-08-26T00:00:00Z"));
    await rescoreWeek(3);
    expect((await pts("GK0_0")).points).toBe(before);
    const { rulesForWeek } = await import("@/lib/services/scoring");
    expect((await rulesForWeek(3)).rules.cleanSheet.points.GK).toBe(5);
    expect((await rulesForWeek(4)).rules.cleanSheet.points.GK).toBe(10);
  });

  it("holds changes to final points for Ben's approval, then applies them with the original rules", async () => {
    await storeDetail({ fixture: fixture("FT", 0, 0), players: [ln("GK0_0", "K0", { saves: 8 }), ln("FWD0_0", "K0", {}), ln("GK1_0", "K1", {})] });
    expect((await pts("GK0_0")).points).toBe(8); // unchanged until approved
    const waiting = await waitingCorrections();
    expect(waiting).toHaveLength(1);
    expect(waiting[0]).toMatchObject({ oldPoints: 8, newPoints: 9 }); // original rules: CS still 5
    const admin = (await one<{ id: number }>("SELECT id FROM users WHERE email = 'admin@x.test'"))!.id;
    await decideCorrection(admin, waiting[0].id, true);
    expect(await pts("GK0_0")).toMatchObject({ points: 9, status: "final" });
    const log = await one<{ n: string }>("SELECT count(*) AS n FROM admin_log WHERE action = 'approve correction'");
    expect(Number(log!.n)).toBe(1);
  });
});
