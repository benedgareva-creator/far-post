// Acceptance check 1 (spec section 9): five hand-scored squads must match exactly.
// Week 2 contains: a double (clubs E and F), blanks (club G), a postponed match moved
// into Week 2, a suspended match resumed after the next deadline (stays in Week 2),
// an abandoned match (void), a second yellow, bench substitutions and a vice-captain.
// Expected totals were worked out by hand; the working is in the comments.
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { addClub, addPlayer, addUser, at, closeDb, resetDb } from "./helpers/db";
import { q } from "@/lib/db";
import { storeDetail, refreshWeeks } from "@/lib/services/sync";
import { rescoreFixture, rescoreWeek } from "@/lib/services/scoring";
import type { ProviderFixture, ProviderPlayerLine } from "@/lib/provider/types";

const ids: Record<string, number> = {};
const clubs: Record<string, number> = {};

type L = Partial<Omit<ProviderPlayerLine, "playerProviderId" | "clubProviderId" | "playerName" | "position">>;
const line = (pid: string, club: string, s: L): ProviderPlayerLine => ({
  playerProviderId: pid, clubProviderId: club, playerName: pid, position: null,
  minutes: 90, goals: 0, assists: 0, saves: 0, yellow: 0, red: 0, ownGoals: 0, penSaved: 0, penMissed: 0, ...s,
});
const fx = (id: string, round: number, home: string, away: string, kickoff: string, status: string, hg: number | null, ag: number | null): ProviderFixture => ({
  providerId: id, round: `Regular Season - ${round}`, roundNumber: round, homeClubProviderId: home, awayClubProviderId: away,
  kickoff: at(kickoff), status, minute: null, homeGoals: hg, awayGoals: ag,
});

async function pick(user: number, week: number, list: [string, number][], captain: string, vice: string) {
  for (const [p, slot] of list) {
    await q("INSERT INTO picks (user_id, week_number, player_id, slot, is_captain, is_vice, price) VALUES ($1,$2,$3,$4,$5,$6,6)", [user, week, ids[p], slot, p === captain, p === vice]);
  }
}

beforeAll(async () => {
  await resetDb();
  for (const c of ["A", "B", "C", "D", "E", "F", "G"]) clubs[c] = await addClub(c);
  const players: [string, string, string][] = [
    ["A_GK", "A", "GK"], ["A_DEF1", "A", "DEF"], ["A_DEF2", "A", "DEF"], ["A_MID1", "A", "MID"], ["A_MID2", "A", "MID"], ["A_FWD1", "A", "FWD"],
    ["B_GK", "B", "GK"], ["B_DEF1", "B", "DEF"], ["B_DEF2", "B", "DEF"], ["B_MID1", "B", "MID"], ["B_FWD1", "B", "FWD"],
    ["C_DEF1", "C", "DEF"], ["C_MID1", "C", "MID"], ["C_MID2", "C", "MID"], ["C_FWD1", "C", "FWD"],
    ["D_GK", "D", "GK"], ["D_DEF1", "D", "DEF"], ["D_MID1", "D", "MID"],
    ["E_GK", "E", "GK"], ["E_DEF1", "E", "DEF"], ["E_MID1", "E", "MID"], ["E_FWD1", "E", "FWD"],
    ["F_GK", "F", "GK"], ["F_DEF1", "F", "DEF"], ["F_MID1", "F", "MID"], ["F_FWD1", "F", "FWD"],
    ["G_GK", "G", "GK"], ["G_DEF1", "G", "DEF"], ["G_MID1", "G", "MID"], ["G_FWD1", "G", "FWD"],
  ];
  for (const [p, c, pos] of players) ids[p] = await addPlayer(p, clubs[c], pos);

  // Fixture list as first published. Deadlines: W1 Aug 1 11:30, W2 Aug 8 11:30, W3 Aug 15 11:30.
  const asPublished = [
    fx("F1", 1, "A", "B", "2026-08-01T12:30:00Z", "NS", null, null),
    fx("F2", 1, "C", "D", "2026-08-01T15:00:00Z", "NS", null, null),
    fx("F3", 1, "E", "F", "2026-08-01T15:00:00Z", "NS", null, null),
    fx("F4", 2, "A", "C", "2026-08-08T12:30:00Z", "NS", null, null),
    fx("F5", 2, "B", "D", "2026-08-08T15:00:00Z", "NS", null, null),
    fx("F8", 2, "F", "E", "2026-08-09T14:00:00Z", "NS", null, null),
    fx("F6", 2, "D", "F", "2026-08-09T16:30:00Z", "NS", null, null),
    fx("F9", 3, "A", "B", "2026-08-15T12:30:00Z", "NS", null, null),
  ];
  for (const f of asPublished) await storeDetail({ fixture: f, players: null });
  await refreshWeeks(asPublished, at("2026-07-20T00:00:00Z"));
});

afterAll(closeDb);

describe("Week assignment", () => {
  it("handles a TV move, a postponement, a resumption and an abandonment", async () => {
    // F2 moved by TV to Monday Aug 3 (still Week 1). F3 postponed, then rescheduled to Wed Aug 12 (Week 2).
    await storeDetail({ fixture: fx("F2", 1, "C", "D", "2026-08-03T19:00:00Z", "NS", null, null), players: null });
    await storeDetail({ fixture: fx("F3", 1, "E", "F", "2026-08-01T15:00:00Z", "PST", null, null), players: null });
    let w = await q<{ provider_id: string; week_number: number | null }>("SELECT provider_id, week_number FROM fixtures ORDER BY provider_id");
    expect(Object.fromEntries(w.map((r) => [r.provider_id, r.week_number]))).toMatchObject({ F1: 1, F2: 1, F3: null, F4: 2, F5: 2, F6: 2, F8: 2, F9: 3 });
    await storeDetail({ fixture: fx("F3", 1, "E", "F", "2026-08-12T18:45:00Z", "NS", null, null), players: null });
    // F5 kicks off, is suspended, and the provider moves its date to the resumption (after Week 3's deadline).
    await storeDetail({ fixture: fx("F5", 2, "B", "D", "2026-08-08T15:00:00Z", "SUSP", 1, 0), players: null });
    await storeDetail({ fixture: fx("F5", 2, "B", "D", "2026-08-16T15:00:00Z", "SUSP", 1, 0), players: null });
    w = await q("SELECT provider_id, week_number FROM fixtures ORDER BY provider_id");
    expect(Object.fromEntries(w.map((r) => [r.provider_id, r.week_number]))).toMatchObject({ F3: 2, F5: 2 });
  });

  it("scores the five hand-worked squads exactly", async () => {
    const W2 = 2;
    // F4: A 1-1 C
    await storeDetail({ fixture: fx("F4", 2, "A", "C", "2026-08-08T12:30:00Z", "FT", 1, 1), players: [
      line("A_GK", "A", { saves: 3 }), // 2 (90 min); 3 saves = 0 blocks; conceded 1 = 0 blocks  => 2
      line("A_DEF1", "A", {}), // 2
      line("A_DEF2", "A", { assists: 1 }), // 2 + 4 = 6
      line("A_MID1", "A", { goals: 1 }), // 2 + 6 = 8
      line("A_MID2", "A", { minutes: 0 }), // unused sub = 0
      line("A_FWD1", "A", { minutes: 70, yellow: 1 }), // 2 - 1 = 1
      line("C_DEF1", "C", {}), // 2
      line("C_MID1", "C", { minutes: 45, yellow: 1, red: 1 }), // second yellow: 1 - 3 = -2 (red replaces yellow)
      line("C_MID2", "C", {}), // 2
      line("C_FWD1", "C", { goals: 1 }), // 2 + 5 = 7
    ] });
    // F5 resumed and finished: B 2-0 D (still Week 2)
    await storeDetail({ fixture: fx("F5", 2, "B", "D", "2026-08-16T15:00:00Z", "FT", 2, 0), players: [
      line("B_GK", "B", { saves: 5, penSaved: 1 }), // 2 + 1 (4 saves) + 5 CS + 5 pen = 13
      line("B_DEF1", "B", {}), // 2 + 5 CS = 7
      line("B_DEF2", "B", { minutes: 59 }), // 1, no clean sheet under 60
      line("B_MID1", "B", { goals: 1, assists: 1 }), // 2 + 6 + 4 + 1 CS = 13
      line("B_FWD1", "B", { goals: 1, penMissed: 1 }), // 2 + 5 - 2 = 5
      line("D_GK", "D", { saves: 8 }), // 2 + 2 (8 saves) - 1 (2 conceded) = 3
      line("D_DEF1", "D", { ownGoals: 1 }), // 2 - 1 - 2 = -1
      line("D_MID1", "D", { minutes: 0 }), // 0
    ] });
    // F3 (rescheduled into Week 2): E 3-2 F
    await storeDetail({ fixture: fx("F3", 1, "E", "F", "2026-08-12T18:45:00Z", "FT", 3, 2), players: [
      line("E_GK", "E", { saves: 2 }), // 2 - 1 = 1
      line("E_DEF1", "E", {}), // 2 - 1 = 1
      line("E_MID1", "E", { goals: 2 }), // 2 + 12 = 14
      line("E_FWD1", "E", { minutes: 0 }), // 0
      line("F_GK", "F", {}), // 2 - 1 (3 conceded = 1 block) = 1
      line("F_DEF1", "F", {}), // 2 - 1 = 1
      line("F_MID1", "F", { minutes: 60 }), // 2
      line("F_FWD1", "F", { goals: 1 }), // 7
    ] });
    // F8: F 1-0 E (E's and F's second match: a double)
    await storeDetail({ fixture: fx("F8", 2, "F", "E", "2026-08-09T14:00:00Z", "FT", 1, 0), players: [
      line("E_GK", "E", { saves: 4 }), // 2 + 1 = 3            => E_GK week 4
      line("E_DEF1", "E", { minutes: 30 }), // 1               => E_DEF1 week 2
      line("E_MID1", "E", {}), // 2 (MID no CS: conceded 1)     => E_MID1 week 16
      line("E_FWD1", "E", { minutes: 0 }), //                  => E_FWD1 week 0
      line("F_GK", "F", {}), // 2 + 5 = 7                       => F_GK week 8
      line("F_DEF1", "F", {}), // 2 + 5 = 7                     => F_DEF1 week 8
      line("F_MID1", "F", { minutes: 0 }), //                  => F_MID1 week 2
      line("F_FWD1", "F", { goals: 1 }), // 7                   => F_FWD1 week 14
    ] });
    // F6: D v F abandoned: void, nothing counts (F_FWD1's goal here must not count).
    await storeDetail({ fixture: fx("F6", 2, "D", "F", "2026-08-09T16:30:00Z", "ABD", 0, 1), players: [
      line("D_MID1", "D", { minutes: 30, goals: 0 }),
      line("F_FWD1", "F", { minutes: 30, goals: 1 }),
    ] });

    const users = [];
    for (let i = 1; i <= 5; i++) users.push(await addUser(`s${i}@x.test`));
    // Squad 1: everyone plays. 2+2+6+7+2+8+13+2+16+7+5 = 70, captain B_MID1 +13 = 83
    await pick(users[0], W2, [["A_GK", 1], ["A_DEF1", 2], ["A_DEF2", 3], ["B_DEF1", 4], ["C_DEF1", 5], ["A_MID1", 6], ["B_MID1", 7], ["C_MID2", 8], ["E_MID1", 9], ["C_FWD1", 10], ["B_FWD1", 11], ["D_GK", 12], ["F_MID1", 13], ["F_FWD1", 14]], "B_MID1", "E_MID1");
    // Squad 2: captain A_MID2 does not play -> vice B_FWD1 doubles. A_MID2 replaced by F_FWD1 (G_MID1 blank, skipped).
    // D_MID1 and E_FWD1 have no one left. 13+1-1+2+8 -2+0+16 +5+0 +14 = 56, vice +5 = 61
    await pick(users[1], W2, [["B_GK", 1], ["B_DEF2", 2], ["D_DEF1", 3], ["E_DEF1", 4], ["F_DEF1", 5], ["A_MID2", 6], ["C_MID1", 7], ["D_MID1", 8], ["E_MID1", 9], ["B_FWD1", 10], ["E_FWD1", 11], ["A_GK", 12], ["G_MID1", 13], ["F_FWD1", 14]], "A_MID2", "B_FWD1");
    // Squad 3: blank goalkeeper G_GK replaced by reserve E_GK (double: 4). Blank G_FWD1 replaced by E_DEF1 (A_MID2 skipped).
    // 4 + 2+7+2 + 8+13+2+16 + 7+14 + 2 = 77, captain E_MID1 +16 = 93
    await pick(users[2], W2, [["G_GK", 1], ["A_DEF1", 2], ["B_DEF1", 3], ["C_DEF1", 4], ["A_MID1", 5], ["B_MID1", 6], ["C_MID2", 7], ["E_MID1", 8], ["G_FWD1", 9], ["C_FWD1", 10], ["F_FWD1", 11], ["E_GK", 12], ["A_MID2", 13], ["E_DEF1", 14]], "E_MID1", "F_FWD1");
    // Squad 4: three defenders, blank G_DEF1 must be replaced by a defender: C_MID1 skipped (formation), D_DEF1 comes on.
    // 13 + 2+7-1 + 8+2+16+13+2 + 7+5 = 74, captain C_FWD1 +7 = 81
    await pick(users[3], W2, [["B_GK", 1], ["A_DEF1", 2], ["B_DEF1", 3], ["G_DEF1", 4], ["A_MID1", 5], ["C_MID2", 6], ["E_MID1", 7], ["B_MID1", 8], ["F_MID1", 9], ["C_FWD1", 10], ["B_FWD1", 11], ["A_GK", 12], ["C_MID1", 13], ["D_DEF1", 14]], "C_FWD1", "B_MID1");
    // Squad 5: captain G_MID1 (blank) and vice E_FWD1 (0 minutes) both miss out: no doubling. Bench never played.
    // 8+8+2+1-1 + 0+8+2 + 0+5+7 = 40
    await pick(users[4], W2, [["F_GK", 1], ["F_DEF1", 2], ["E_DEF1", 3], ["B_DEF2", 4], ["D_DEF1", 5], ["G_MID1", 6], ["A_MID1", 7], ["C_MID2", 8], ["E_FWD1", 9], ["B_FWD1", 10], ["C_FWD1", 11], ["B_GK", 12], ["D_MID1", 13], ["A_MID2", 14]], "G_MID1", "E_FWD1");
    await q("UPDATE weeks SET locked = true WHERE number = 2");

    const now = at("2026-08-30T00:00:00Z");
    const fixtures = await q<{ id: number }>("SELECT id FROM fixtures");
    for (const f of fixtures) await rescoreFixture(f.id, now);
    await rescoreWeek(W2);

    const res = await q<{ user_id: number; points: number; status: string }>("SELECT user_id, points, status FROM team_week_points WHERE week_number = 2 ORDER BY user_id");
    expect(res.map((r) => r.points)).toEqual([83, 61, 93, 81, 40]);
    expect(res.every((r) => r.status === "final")).toBe(true);
    const voided = await q("SELECT * FROM player_points WHERE fixture_id = (SELECT id FROM fixtures WHERE provider_id = 'F6')");
    expect(voided).toHaveLength(0);
  });

  it("counts a replay of an abandoned match once, in the replay's Week", async () => {
    await storeDetail({ fixture: fx("F6", 2, "D", "F", "2026-08-19T19:00:00Z", "NS", null, null), players: null });
    const row = await q<{ week_number: number; n: string }>("SELECT week_number, (SELECT count(*) FROM player_match_stats s WHERE s.fixture_id = f.id) AS n FROM fixtures f WHERE provider_id = 'F6'");
    expect(row[0].week_number).toBe(3);
    expect(Number(row[0].n)).toBe(0);
  });
});
