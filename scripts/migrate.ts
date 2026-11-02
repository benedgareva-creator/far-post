// Applies any database migrations that have not run yet. Safe to run on every deploy.
import "./env";
import fs from "node:fs";
import path from "node:path";
import { pool } from "../src/lib/db";

async function main() {
  const db = pool();
  await db.query("CREATE TABLE IF NOT EXISTS schema_migrations (name text PRIMARY KEY, applied_at timestamptz NOT NULL DEFAULT now())");
  const dir = path.join(__dirname, "..", "migrations");
  const files = fs.readdirSync(dir).filter((f) => f.endsWith(".sql")).sort();
  for (const f of files) {
    const done = await db.query("SELECT 1 FROM schema_migrations WHERE name = $1", [f]);
    if (done.rowCount) continue;
    const c = await db.connect();
    try {
      await c.query("BEGIN");
      await c.query(fs.readFileSync(path.join(dir, f), "utf8"));
      await c.query("INSERT INTO schema_migrations (name) VALUES ($1)", [f]);
      await c.query("COMMIT");
      console.log(`Applied ${f}`);
    } catch (e) {
      await c.query("ROLLBACK");
      throw e;
    } finally {
      c.release();
    }
  }
  console.log("Database is up to date.");
  await db.end();
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
