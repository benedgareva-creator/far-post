// Demo-mode fault switch: lets Ben (and the tests) see how the poller reacts to
// "too many requests" and "blocked" replies without a real supplier.
import { getSetting, type Db, pool } from "../lib/db";
import type { CallMeta, FootballProvider, ProviderResult } from "../lib/provider/types";

export type Fault = "rate" | "block" | "day" | null;

export function withFaults(inner: FootballProvider, fault: () => Promise<Fault>): FootballProvider {
  const wrap = <A extends unknown[], T>(fn: (...a: A) => Promise<ProviderResult<T>>, name: string) =>
    async (...a: A): Promise<ProviderResult<T>> => {
      const f = await fault();
      if (!f) return fn(...a);
      if (inner.throttle) await inner.throttle();
      const meta: CallMeta = {
        endpoint: `${name} (simulated fault)`,
        httpStatus: f === "rate" ? 429 : f === "block" ? 403 : 200,
        ok: false,
        dayLimit: null,
        dayRemaining: f === "day" ? 0 : null,
        minuteLimit: null,
        minuteRemaining: f === "rate" ? 0 : null,
        rateLimited: f === "rate",
        blocked: f === "block",
        dayExhausted: f === "day",
        error: f === "rate" ? "rateLimit: Too many requests" : f === "block" ? "access: Your account is suspended" : "requests: Daily limit reached",
      };
      if (inner.onCall) await inner.onCall(meta);
      return { ok: false, error: meta.error!, calls: [meta] };
    };
  const p: FootballProvider = {
    name: inner.name,
    batchSize: inner.batchSize,
    callsForLiveFetch: (n) => inner.callsForLiveFetch(n),
    getClubs: wrap(() => inner.getClubs(), "teams"),
    getPlayers: wrap((id: string) => inner.getPlayers(id), "players"),
    getSquad: wrap((id: string) => inner.getSquad(id), "players/squads"),
    getFixtures: wrap(() => inner.getFixtures(), "fixtures"),
    getFixtureDetails: wrap((ids: string[]) => inner.getFixtureDetails(ids), "fixtures?ids"),
    getAccountStatus: wrap(() => inner.getAccountStatus(), "status"),
  };
  // Throttle set on the wrapper by the poller is passed through to the real adapter.
  Object.defineProperty(p, "throttle", {
    get: () => inner.throttle,
    set: (v) => (inner.throttle = v),
  });
  Object.defineProperty(p, "onCall", {
    get: () => inner.onCall,
    set: (v) => (inner.onCall = v),
  });
  return p;
}

export async function demoFault(db: Db = pool()): Promise<Fault> {
  return (await getSetting<Fault>("mock_fault", db)) ?? null;
}
