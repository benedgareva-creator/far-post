// Acceptance check 4 (spec section 9): limits and blocks enforce pacing, stopping and alerts.
// Also checks the real API-Football adapter's parsing against a fake server.
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { closeDb, resetDb } from "./helpers/db";
import { getSetting, one, q, setSetting } from "@/lib/db";
import { MockProvider } from "@/lib/provider/mock";
import { ApiFootballProvider } from "@/lib/provider/apiFootball";
import { Poller } from "@/poller/poller";
import { withFaults, type Fault } from "@/poller/faults";
import { syncCatalogue, syncFixtures } from "@/lib/services/sync";

let clock = new Date();
const anchor = new Date("2026-08-01T11:30:00Z");
let fault: Fault = null;
const sleeps: number[] = [];

function makePoller(limits = { day: 7500, minute: 300 }) {
  const provider = withFaults(new MockProvider({ anchor, now: () => clock }), async () => fault);
  return new Poller({
    provider,
    now: () => clock,
    sleep: async (ms) => {
      sleeps.push(ms);
      clock = new Date(clock.getTime() + ms);
    },
    log: () => {},
    limits,
  });
}

beforeAll(async () => {
  await resetDb();
  await setSetting("launch_round", 1);
  clock = new Date("2026-07-25T00:00:00Z");
  const p = new MockProvider({ anchor, now: () => clock });
  await syncCatalogue(p);
  await syncFixtures(p, clock);
});
afterAll(closeDb);

describe("poller", () => {
  it("fetches live matches once a minute, spacing calls at least a second apart", async () => {
    const poller = makePoller();
    clock = new Date(anchor.getTime() + 160 * 60_000); // 15:00 matches are 10 minutes in
    const did = await poller.tick();
    expect(did.join(" ")).toMatch(/live: 6 match/);
    const again = await poller.tick(); // same minute: no new live fetch
    expect(again.join(" ")).not.toMatch(/live:/);
    clock = new Date(clock.getTime() + 61_000);
    expect((await poller.tick()).join(" ")).toMatch(/live:/);
    const pts = await one<{ n: string }>("SELECT count(*) AS n FROM player_points WHERE status = 'live'");
    expect(Number(pts!.n)).toBeGreaterThan(50);
    expect(await getSetting("last_success")).not.toBeNull();
  });

  it("counts requests across restarts and slows down at 80% / 90%, stops at 95%", async () => {
    const day = clock.toISOString().slice(0, 10);
    // Pretend 6,000 requests were already made today (80% of Pro) by an earlier poller process.
    await q("INSERT INTO api_requests (at, utc_day, endpoint, purpose, ok) SELECT $1, $2, 'x', 'live', true FROM generate_series(1, 6000)", [clock, day]);
    const poller = makePoller();
    expect((await poller.pacing()).mode).toBe("slow");
    await q("INSERT INTO api_requests (at, utc_day, endpoint, purpose, ok) SELECT $1, $2, 'x', 'live', true FROM generate_series(1, 1200)", [clock, day]);
    expect((await poller.pacing()).mode).toBe("stopped");
    const did = await poller.tick();
    expect(did.join(" ")).not.toMatch(/live:/);
    const alert = await one<{ level: string }>("SELECT level FROM alerts WHERE kind = 'budget-95' AND resolved_at IS NULL");
    expect(alert?.level).toBe("critical");
    await q("DELETE FROM api_requests WHERE endpoint = 'x'");
    await q("DELETE FROM alerts");
  });

  it("uses five calls a minute on the Free plan", async () => {
    await q("DELETE FROM api_requests");
    const provider = withFaults(new MockProvider({ anchor, now: () => clock }), async () => null);
    new Poller({ provider, now: () => clock, sleep: async (ms) => { sleeps.push(ms); clock = new Date(clock.getTime() + ms); }, log: () => {}, limits: { day: 100, minute: 10 } });
    sleeps.length = 0;
    await provider.getFixtures();
    await provider.getFixtures();
    expect(sleeps).toEqual([12_000]); // 60 s / (10 / 2) = one call every 12 s
  });

  it("backs off on 'too many requests' with increasing waits", async () => {
    const poller = makePoller();
    fault = "rate";
    const waits: string[] = [];
    for (let i = 0; i < 3; i++) {
      clock = new Date(clock.getTime() + 61_000);
      await poller.tick();
      waits.push((await poller.tick()).join(" "));
      clock = new Date(clock.getTime() + 20 * 60_000); // let the back-off expire
    }
    expect(waits[0]).toMatch(/backing off/);
    const alert = await one("SELECT 1 FROM alerts WHERE kind = 'rate-limited'");
    expect(alert).not.toBeNull();
    fault = null;
  });

  it("stops completely when blocked, alerts Ben by email at once, and resumes only when cleared", async () => {
    const poller = makePoller();
    fault = "block";
    clock = new Date(clock.getTime() + 61_000);
    await poller.tick();
    const alert = await one<{ level: string; emailed: boolean; at: Date }>("SELECT level, emailed, at FROM alerts WHERE kind = 'blocked'");
    expect(alert).toMatchObject({ level: "critical", emailed: true });
    const before = await one<{ n: string }>("SELECT count(*) AS n FROM api_requests");
    fault = null;
    clock = new Date(clock.getTime() + 5 * 60_000);
    expect(await poller.tick()).toContain("blocked");
    const after = await one<{ n: string }>("SELECT count(*) AS n FROM api_requests");
    expect(after!.n).toBe(before!.n); // no further attempts
    await q("DELETE FROM settings WHERE key = 'poller_blocked'");
    expect((await poller.tick()).join(" ")).not.toMatch(/blocked/);
  });

  it("rechecks finished matches at 30 minutes, 24 hours and 72 hours, then makes points final", async () => {
    const poller = makePoller();
    clock = new Date(anchor.getTime() + 450 * 60_000 + 140 * 60_000); // after the 20:00 games end
    await poller.tick();
    clock = new Date(clock.getTime() + 61_000);
    await poller.tick();
    const fx = await one<{ id: number; finished_at: Date }>("SELECT id, finished_at FROM fixtures WHERE provider_id = '90101'");
    clock = new Date(fx!.finished_at.getTime() + 31 * 60_000);
    await poller.tick();
    expect((await one<{ recheck_stage: number }>("SELECT recheck_stage FROM fixtures WHERE id = $1", [fx!.id]))!.recheck_stage).toBeGreaterThanOrEqual(1);
    clock = new Date(fx!.finished_at.getTime() + 73 * 3600_000);
    await poller.tick();
    const st = await one<{ recheck_stage: number }>("SELECT recheck_stage FROM fixtures WHERE id = $1", [fx!.id]);
    expect(st!.recheck_stage).toBe(3);
    const fin = await one<{ s: string }>("SELECT string_agg(DISTINCT status, ',') AS s FROM player_points WHERE fixture_id = $1", [fx!.id]);
    expect(fin!.s).toBe("final");
  });

  it("only one poller can hold the lock", async () => {
    const { pool } = await import("@/lib/db");
    const a = await pool().connect();
    const b = await pool().connect();
    const r1 = await a.query("SELECT pg_try_advisory_lock(7042026) AS ok");
    const r2 = await b.query("SELECT pg_try_advisory_lock(7042026) AS ok");
    expect([r1.rows[0].ok, r2.rows[0].ok]).toEqual([true, false]);
    await a.query("SELECT pg_advisory_unlock(7042026)");
    a.release();
    b.release();
  });
});

describe("API-Football adapter", () => {
  const reply = (body: unknown, headers: Record<string, string> = {}, status = 200) =>
    (async (..._args: unknown[]) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json", ...headers } })) as unknown as typeof fetch;

  it("reads limits from headers and parses players, blanks and own goals", async () => {
    let seenUrl = "";
    let seenKey = "";
    const fetchImpl = (async (url: URL, init: RequestInit) => {
      seenUrl = String(url);
      seenKey = (init.headers as Record<string, string>)["x-apisports-key"];
      return reply(
        {
          errors: [],
          response: [
            {
              fixture: { id: 55, date: "2026-08-08T14:00:00+00:00", status: { short: "FT", elapsed: 90 } },
              league: { round: "Regular Season - 3" },
              teams: { home: { id: 1 }, away: { id: 2 } },
              goals: { home: 2, away: 1 },
              events: [{ type: "Goal", detail: "Own Goal", player: { id: 900 }, team: { id: 2 } }],
              players: [
                { team: { id: 1 }, players: [{ player: { id: 10, name: "A" }, statistics: [{ games: { minutes: 90, position: "F" }, goals: { total: 1, assists: null, saves: null }, cards: { yellow: 0, red: 0 }, penalty: { saved: null, missed: 0 } }] }] },
                { team: { id: 2 }, players: [{ player: { id: 900, name: "B" }, statistics: [{ games: { minutes: null, position: "D" }, goals: { total: null }, cards: {}, penalty: {} }] }] },
              ],
            },
          ],
        },
        { "x-ratelimit-requests-limit": "7500", "x-ratelimit-requests-remaining": "7400", "X-RateLimit-Limit": "300", "X-RateLimit-Remaining": "299" },
      )(url, init);
    }) as unknown as typeof fetch;
    const p = new ApiFootballProvider({ key: "secret", baseUrl: "https://v3.football.api-sports.io", leagueId: "39", season: "2026", batch: true, fetchImpl });
    const r = await p.getFixtureDetails(["55", "56"]);
    expect(seenUrl).toContain("fixtures?ids=55-56");
    expect(seenKey).toBe("secret");
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.calls[0]).toMatchObject({ dayLimit: 7500, dayRemaining: 7400, minuteLimit: 300, minuteRemaining: 299 });
    const [a, b] = r.data[0].players!;
    expect(a).toMatchObject({ minutes: 90, goals: 1, assists: 0, saves: 0, ownGoals: 0, position: "FWD" });
    expect(b).toMatchObject({ minutes: 0, ownGoals: 1, position: "DEF" }); // blank minutes in a finished match = did not play
  });

  it("classifies limit, exhausted and blocked replies", async () => {
    const mk = (body: unknown, status = 200) => new ApiFootballProvider({ key: "k", baseUrl: "https://x.test", leagueId: "39", season: "2026", batch: true, fetchImpl: reply(body, {}, status) });
    expect((await mk({ errors: { rateLimit: "Too many requests" }, response: [] }).getFixtures()).calls[0].rateLimited).toBe(true);
    expect((await mk({ errors: { requests: "You have reached the request limit for the day" }, response: [] }).getFixtures()).calls[0].dayExhausted).toBe(true);
    expect((await mk({ errors: { token: "Error/Missing application key" }, response: [] }).getFixtures()).calls[0].blocked).toBe(true);
    expect((await mk({ message: "Forbidden" }, 403).getFixtures()).calls[0].blocked).toBe(true);
  });

  it("uses two calls per match in fallback mode", () => {
    const p = new ApiFootballProvider({ key: "k", baseUrl: "https://x.test", leagueId: "39", season: "2026", batch: false });
    expect(p.callsForLiveFetch(10)).toBe(20);
    expect(new ApiFootballProvider({ key: "k", baseUrl: "https://x.test", leagueId: "39", season: "2026", batch: true }).callsForLiveFetch(10)).toBe(1);
  });
});
