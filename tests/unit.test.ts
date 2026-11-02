import { describe, expect, it } from "vitest";
import { scorePlayerMatch } from "@/lib/scoring/engine";
import { DEFAULT_RULES, type StatLine } from "@/lib/scoring/rules";
import { suggestPrices } from "@/lib/game/pricing";
import { defaultLineup, validateLineup, validateSquad, transfersAllowed, type SquadPlayer } from "@/lib/game/rules";
import { nextDeadline, weekForKickoff } from "@/lib/game/weeks";
import { pacing, backoffMs, expectedDailyCalls } from "@/poller/budget";

const s = (x: Partial<StatLine>): StatLine => ({ minutes: 90, goals: 0, assists: 0, saves: 0, yellow: 0, red: 0, ownGoals: 0, penSaved: 0, penMissed: 0, clubConceded: 0, ...x });

describe("scoring engine", () => {
  it("scores goals by position", () => {
    expect(scorePlayerMatch(s({ goals: 1, clubConceded: 1 }), "DEF", DEFAULT_RULES).points).toBe(2 + 7);
    expect(scorePlayerMatch(s({ goals: 1, clubConceded: 1 }), "MID", DEFAULT_RULES).points).toBe(2 + 6);
    expect(scorePlayerMatch(s({ goals: 1, clubConceded: 1 }), "FWD", DEFAULT_RULES).points).toBe(2 + 5);
    expect(scorePlayerMatch(s({ goals: 1, clubConceded: 1 }), "GK", DEFAULT_RULES).points).toBe(2 + 7);
  });
  it("gives minutes points 1 or 2 in total", () => {
    expect(scorePlayerMatch(s({ minutes: 0 }), "FWD", DEFAULT_RULES).points).toBe(0);
    expect(scorePlayerMatch(s({ minutes: 1 }), "FWD", DEFAULT_RULES).points).toBe(1);
    expect(scorePlayerMatch(s({ minutes: 59 }), "FWD", DEFAULT_RULES).points).toBe(1);
    expect(scorePlayerMatch(s({ minutes: 60 }), "FWD", DEFAULT_RULES).points).toBe(2);
  });
  it("counts complete blocks of saves and goals conceded", () => {
    expect(scorePlayerMatch(s({ saves: 7, clubConceded: 3 }), "GK", DEFAULT_RULES).points).toBe(2 + 1 - 1);
    expect(scorePlayerMatch(s({ saves: 8, clubConceded: 4 }), "GK", DEFAULT_RULES).points).toBe(2 + 2 - 2);
  });
  it("gives clean sheets only with 60+ minutes", () => {
    expect(scorePlayerMatch(s({ minutes: 59 }), "DEF", DEFAULT_RULES).points).toBe(1);
    expect(scorePlayerMatch(s({ minutes: 60 }), "DEF", DEFAULT_RULES).points).toBe(7);
    expect(scorePlayerMatch(s({}), "MID", DEFAULT_RULES).points).toBe(3);
    expect(scorePlayerMatch(s({}), "FWD", DEFAULT_RULES).points).toBe(2);
  });
  it("loses a substituted player's clean sheet if the club concedes later", () => {
    // Played 70 minutes, club conceded in the 85th: club total is 1, so no clean sheet.
    expect(scorePlayerMatch(s({ minutes: 70, clubConceded: 1 }), "DEF", DEFAULT_RULES).points).toBe(2);
  });
  it("lets a red card replace the yellow", () => {
    expect(scorePlayerMatch(s({ yellow: 1, red: 1, clubConceded: 1 }), "MID", DEFAULT_RULES).points).toBe(2 - 3);
    expect(scorePlayerMatch(s({ yellow: 1, clubConceded: 1 }), "MID", DEFAULT_RULES).points).toBe(2 - 1);
  });
  it("scores own goals and penalties", () => {
    expect(scorePlayerMatch(s({ ownGoals: 1, clubConceded: 1 }), "DEF", DEFAULT_RULES).points).toBe(2 - 2);
    expect(scorePlayerMatch(s({ penSaved: 1, clubConceded: 1 }), "GK", DEFAULT_RULES).points).toBe(2 + 5);
    expect(scorePlayerMatch(s({ penMissed: 1, clubConceded: 1 }), "FWD", DEFAULT_RULES).points).toBe(2 - 2);
  });
  it("leaves unknown numbers pending instead of guessing", () => {
    const r = scorePlayerMatch(s({ saves: null, clubConceded: null }), "GK", DEFAULT_RULES);
    expect(r.pending.sort()).toEqual(["cleanSheet", "conceded", "saves"]);
    expect(r.points).toBe(2);
  });
  it("respects disabled measures and eligible positions", () => {
    const rules = structuredClone(DEFAULT_RULES);
    rules.saves.enabled = false;
    rules.cleanSheet.eligible = ["GK"];
    expect(scorePlayerMatch(s({ saves: 8 }), "GK", rules).points).toBe(2 + 5);
    expect(scorePlayerMatch(s({}), "DEF", rules).points).toBe(2);
  });
});

describe("prices", () => {
  it("bands by rank within position with id tie-break, unreliable = 6", () => {
    const players = Array.from({ length: 20 }, (_, i) => ({ id: i + 1, position: "FWD" as const, goals: 20 - i, assists: 0, minutes: 900 }));
    players.push({ id: 99, position: "FWD", goals: null as unknown as number, assists: 0, minutes: 900 });
    const out = suggestPrices(players, DEFAULT_RULES.goal.points);
    const price = (id: number) => out.find((o) => o.id === id)!.price;
    expect(price(1)).toBe(10); // top 5% of 20 = 1 player
    expect([2, 3, 4].map(price)).toEqual([8, 8, 8]); // next 15% = 3
    expect([5, 6, 7, 8, 9, 10].map(price)).toEqual([6, 6, 6, 6, 6, 6]); // next 30% = 6
    expect(price(11)).toBe(4);
    expect(price(99)).toBe(6);
    const tie = suggestPrices([{ id: 5, position: "MID", goals: 1, assists: 0, minutes: 90 }, ...Array.from({ length: 19 }, (_, i) => ({ id: 10 + i, position: "MID" as const, goals: i === 0 ? 1 : 0, assists: 0, minutes: 90 }))], DEFAULT_RULES.goal.points);
    expect(tie.find((t) => t.id === 5)!.price).toBe(10); // tie with id 10: lower id wins
  });
});

describe("squad and lineup rules", () => {
  const squad = (): SquadPlayer[] => [
    ...[1, 2].map((id) => ({ id, position: "GK" as const, clubId: id, price: 4 })),
    ...[3, 4, 5, 6].map((id) => ({ id, position: "DEF" as const, clubId: id, price: 6 })),
    ...[7, 8, 9, 10, 11].map((id) => ({ id, position: "MID" as const, clubId: id, price: 8 })),
    ...[12, 13, 14].map((id) => ({ id, position: "FWD" as const, clubId: id, price: 6 })),
  ];
  it("accepts a valid squad", () => expect(validateSquad(squad())).toEqual([])); // 8+24+40+18 = 90
  it("rejects over budget, wrong shape and four from one club", () => {
    const sq = squad();
    for (const p of sq) if (p.position !== "GK") p.price = 8; // 8 + 12*8 = 104
    expect(validateSquad(sq).join(" ")).toMatch(/over the 100 budget/);
    expect(validateSquad(squad().slice(1)).join(" ")).toMatch(/14 players/);
    const club = squad().map((p, i) => (i < 4 ? { ...p, clubId: 99 } : p));
    expect(validateSquad(club).join(" ")).toMatch(/at most 3/);
  });
  it("builds a valid default lineup and rejects bad formations", () => {
    const lu = defaultLineup(squad());
    expect(validateLineup(lu)).toEqual([]);
    const bad = lu.map((e) => (e.position === "FWD" && e.slot <= 11 ? { ...e, slot: e.slot } : e));
    const fwdStarters = bad.filter((e) => e.position === "FWD" && e.slot <= 11);
    const benchMid = bad.find((e) => e.slot === 13)!;
    // Swap both starting forwards out for bench players: leaves at most 1 forward... move to 0 forwards
    const swapped = bad.map((e) => (e.playerId === fwdStarters[0].playerId ? { ...e, slot: 13 } : e.playerId === benchMid.playerId ? { ...e, slot: fwdStarters[0].slot } : e));
    expect(validateLineup(swapped)).toEqual([]); // still one forward
    const twoGk = lu.map((e) => (e.slot === 12 ? { ...e, slot: 2 } : e.slot === 2 ? { ...e, slot: 12 } : e));
    expect(validateLineup(twoGk).join(" ")).toMatch(/goalkeeper/);
  });
  it("allows unlimited transfers before the first deadline, then two a week", () => {
    expect(transfersAllowed({ teamHasPlayedADeadline: false, madeThisWeek: 9 })).toBeNull();
    expect(transfersAllowed({ teamHasPlayedADeadline: true, madeThisWeek: 1 })).toBe(1);
    expect(transfersAllowed({ teamHasPlayedADeadline: true, madeThisWeek: 2 })).toBe(0);
  });
});

describe("week timing", () => {
  const round = [{ kickoff: new Date("2026-08-15T12:30:00Z"), status: "NS" }];
  it("puts the deadline an hour before the first kickoff and freezes it 7 days out", () => {
    const far = nextDeadline(null, round, new Date("2026-08-01T00:00:00Z"))!;
    expect(far.deadline.toISOString()).toBe("2026-08-15T11:30:00.000Z");
    expect(far.frozen).toBe(false);
    const near = nextDeadline(null, round, new Date("2026-08-09T00:00:00Z"))!;
    expect(near.frozen).toBe(true);
    // A TV move after the freeze does not move the deadline.
    const moved = nextDeadline({ number: 3, ...near }, [{ kickoff: new Date("2026-08-14T19:00:00Z"), status: "NS" }], new Date("2026-08-10T00:00:00Z"))!;
    expect(moved.deadline.toISOString()).toBe("2026-08-15T11:30:00.000Z");
    // Before the freeze it follows the schedule.
    const early = nextDeadline({ number: 3, ...far }, [{ kickoff: new Date("2026-08-14T19:00:00Z"), status: "NS" }], new Date("2026-08-01T00:00:00Z"))!;
    expect(early.deadline.toISOString()).toBe("2026-08-14T18:00:00.000Z");
  });
  it("assigns kickoffs to the week containing them", () => {
    const weeks = [1, 2, 3].map((n) => ({ number: n, deadline: new Date(Date.UTC(2026, 7, 1 + (n - 1) * 7, 11, 30)), frozen: true }));
    expect(weekForKickoff(new Date("2026-07-31T12:00:00Z"), weeks)).toBeNull();
    expect(weekForKickoff(new Date("2026-08-07T20:00:00Z"), weeks)).toBe(1);
    expect(weekForKickoff(new Date("2026-08-08T11:30:00Z"), weeks)).toBe(2);
  });
});

describe("request budget", () => {
  it("matches the spec's daily estimates", () => {
    expect(expectedDailyCalls({ activeMinutes: 630, matchMinutes: 1800, batch: true })).toBe(891);
    expect(expectedDailyCalls({ activeMinutes: 630, matchMinutes: 1800, batch: false })).toBe(5211);
  });
  it("slows at 80% and 90%, stops live at 95%", () => {
    const p = (used: number) => pacing({ dayLimit: 7500, minuteLimit: 300, usedToday: used });
    expect(p(100)).toMatchObject({ mode: "normal", liveIntervalSec: 60, minGapMs: 1000 });
    expect(p(6000)).toMatchObject({ mode: "slow", liveIntervalSec: 120 });
    expect(p(6750)).toMatchObject({ mode: "slower", liveIntervalSec: 300 });
    expect(p(7125)).toMatchObject({ mode: "stopped", correctionsAllowed: true });
    expect(p(7500)).toMatchObject({ mode: "stopped", correctionsAllowed: false });
  });
  it("uses five calls a minute on Free and backs off increasingly", () => {
    expect(pacing({ dayLimit: 100, minuteLimit: 10, usedToday: 0 }).minGapMs).toBe(12000);
    expect([1, 2, 3, 10].map(backoffMs)).toEqual([30000, 60000, 120000, 900000]);
  });
});
