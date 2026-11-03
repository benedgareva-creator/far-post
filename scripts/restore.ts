// Restores a JSON backup (from Admin > Health or `npm run backup`) into an EMPTY database.
// Run: `npm run db:migrate` then `npm run restore -- path/to/backup.json --yes`.
import "./env";
import fs from "node:fs";
import { pool } from "../src/lib/db";

// Parents before children so foreign keys are satisfied.
const ORDER = ["users", "invites", "clubs", "players", "rulesets", "weeks", "fixtures", "player_match_stats", "player_points", "squad_players", "picks", "transfers", "team_week_points", "leagues", "league_members", "corrections", "alerts", "admin_log", "settings"];
const JSON_COLS = new Set(["config", "breakdown", "pending", "detail", "old_stats", "new_stats", "details", "value"]);

async function main() {
  const file = process.argv[2];
  if (!file || !process.argv.includes("--yes")) {
    console.log("Usage: npm run restore -- <backup.json> --yes   (database must be empty apart from the schema)");
    process.exit(1);
  }
  const data = JSON.parse(fs.readFileSync(file, "utf8"));
  if (data.app !== "far-post") throw new Error("Not a Far Post backup.");
  const c = await pool().connect();
  try {
    await c.query("BEGIN");
    const existing = await c.query("SELECT count(*) AS n FROM users");
    if (Number(existing.rows[0].n) > 0) throw new Error("The database already has data. Restore into a fresh, empty database.");
    for (const table of ORDER) {
      const rows: Record<string, unknown>[] = data.tables[table] ?? [];
      for (const row of rows) {
        const cols = Object.keys(row);
        const vals = cols.map((k) => (JSON_COLS.has(k) && row[k] !== null ? JSON.stringify(row[k]) : row[k]));
        await c.query(`INSERT INTO ${table} (${cols.map((k) => `"${k}"`).join(",")}) VALUES (${cols.map((_, i) => `$${i + 1}`).join(",")})`, vals);
      }
      // Keep id counters ahead of restored rows.
      const hasId = await c.query("SELECT 1 FROM information_schema.columns WHERE table_name = $1 AND column_name = 'id'", [table]);
      const seq = hasId.rowCount ? await c.query("SELECT pg_get_serial_sequence($1, 'id') AS s", [table]) : { rows: [{ s: null }] };
      if (seq.rows[0]?.s) await c.query(`SELECT setval($1, COALESCE((SELECT max(id) FROM ${table}), 0) + 1, false)`, [seq.rows[0].s]);
      console.log(`${table}: ${rows.length}`);
    }
    await c.query("COMMIT");
    console.log("Restore complete.");
  } catch (e) {
    await c.query("ROLLBACK");
    throw e;
  } finally {
    c.release();
    await pool().end();
  }
}

main().catch((e) => {
  console.error(e.message ?? e);
  process.exit(1);
});
