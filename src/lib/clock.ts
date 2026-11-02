// The game's clock. In demo mode an offset can shift time (for previews and tests).
import { getSetting, type Db, pool } from "./db";
import { config } from "./config";

export async function now(db: Db = pool()): Promise<Date> {
  if (config.provider !== "mock") return new Date();
  const offset = await getSetting<number>("mock_clock_offset_ms", db);
  return new Date(Date.now() + (offset ?? 0));
}
