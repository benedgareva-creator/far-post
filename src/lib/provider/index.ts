import { config, PLAN_LIMITS } from "../config";
import { getSetting, type Db, pool } from "../db";
import { ApiFootballProvider } from "./apiFootball";
import { MockProvider } from "./mock";
import type { FootballProvider } from "./types";

export * from "./types";

/** The configured data supplier. Demo data unless FOOTBALL_PROVIDER=api-football and a key is set. */
export async function getProvider(db: Db = pool()): Promise<FootballProvider> {
  const af = config.apiFootball;
  if (config.provider === "api-football") {
    if (!af.key) throw new Error("FOOTBALL_PROVIDER is api-football but API_FOOTBALL_KEY is empty.");
    return new ApiFootballProvider(af);
  }
  const anchor = await getSetting<string>("mock_anchor", db);
  if (!anchor) throw new Error("Demo league not set up yet: run `npm run db:seed`.");
  const clock = await getSetting<number>("mock_clock_offset_ms", db);
  return new MockProvider({
    anchor: new Date(anchor),
    now: () => new Date(Date.now() + (clock ?? 0)),
    dayLimit: PLAN_LIMITS[af.plan].day,
    minuteLimit: PLAN_LIMITS[af.plan].minute,
  });
}
