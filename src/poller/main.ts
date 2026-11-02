// Starts the poller: `npm run poller`. Render runs this as a separate background worker.
import "../../scripts/env";
import { config, PLAN_LIMITS } from "../lib/config";
import { now as gameNow } from "../lib/clock";
import { pool } from "../lib/db";
import { getProvider } from "../lib/provider";
import { demoFault, withFaults } from "./faults";
import { Poller, POLLER_LOCK_ID } from "./poller";

async function main() {
  // A dedicated connection holds the lock; if another poller has it, stop.
  const lockClient = await pool().connect();
  const got = await lockClient.query<{ ok: boolean }>("SELECT pg_try_advisory_lock($1) AS ok", [POLLER_LOCK_ID]);
  if (!got.rows[0].ok) {
    console.error("Another poller is already running. Exiting so only one fetches data.");
    process.exit(0);
  }
  let provider = await getProvider();
  if (config.provider === "mock") provider = withFaults(provider, () => demoFault());
  // In demo mode the game clock may be shifted; use it so live matches line up.
  let offset = 0;
  const refreshOffset = async () => {
    offset = (await gameNow()).getTime() - Date.now();
  };
  await refreshOffset();
  const limits = PLAN_LIMITS[config.apiFootball.plan];
  const poller = new Poller({ provider, now: () => new Date(Date.now() + offset), limits });
  console.log(`Poller started (${provider.name}, plan ${config.apiFootball.plan}: ${limits.day}/day, ${limits.minute}/minute).`);
  let stopping = false;
  const stop = () => {
    stopping = true;
  };
  process.on("SIGTERM", stop);
  process.on("SIGINT", stop);
  while (!stopping) {
    try {
      await refreshOffset();
      const did = await poller.tick();
      if (did.length) console.log(`[${new Date().toISOString()}] ${did.join("; ")}`);
    } catch (e) {
      console.error("Poller error:", e);
    }
    await new Promise((r) => setTimeout(r, 5_000));
  }
  lockClient.release();
  await pool().end();
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
