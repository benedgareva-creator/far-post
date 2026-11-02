// Database access: plain SQL with parameters (never string-built SQL).
import { Pool, type PoolClient, type QueryResultRow } from "pg";
import { config } from "../config";

declare global {
  // eslint-disable-next-line no-var
  var __farpostPool: Pool | undefined;
}

export function pool(): Pool {
  if (!globalThis.__farpostPool) {
    const url = config.databaseUrl;
    globalThis.__farpostPool = new Pool({
      connectionString: url,
      max: Number(process.env.DB_POOL_SIZE ?? 10),
      ssl: url.includes("localhost") || url.includes("127.0.0.1") || process.env.DB_SSL === "false" ? undefined : { rejectUnauthorized: false },
    });
  }
  return globalThis.__farpostPool;
}

export type Db = Pool | PoolClient;

export async function q<T extends QueryResultRow = QueryResultRow>(text: string, params: unknown[] = [], db: Db = pool()): Promise<T[]> {
  const res = await db.query<T>(text, params);
  return res.rows;
}

export async function one<T extends QueryResultRow = QueryResultRow>(text: string, params: unknown[] = [], db: Db = pool()): Promise<T | null> {
  const rows = await q<T>(text, params, db);
  return rows[0] ?? null;
}

/** Runs fn in a transaction. Serializable isolation so concurrent squad edits cannot both pass the budget check. */
export async function tx<T>(fn: (c: PoolClient) => Promise<T>, opts: { serializable?: boolean } = {}): Promise<T> {
  for (let attempt = 0; ; attempt++) {
    const c = await pool().connect();
    try {
      await c.query(opts.serializable ? "BEGIN ISOLATION LEVEL SERIALIZABLE" : "BEGIN");
      const out = await fn(c);
      await c.query("COMMIT");
      return out;
    } catch (e) {
      await c.query("ROLLBACK").catch(() => {});
      const code = (e as { code?: string }).code;
      if (opts.serializable && code === "40001" && attempt < 2) continue; // retry once on conflict
      throw e;
    } finally {
      c.release();
    }
  }
}

export async function getSetting<T>(key: string, db: Db = pool()): Promise<T | null> {
  const row = await one<{ value: T }>("SELECT value FROM settings WHERE key = $1", [key], db);
  return row ? row.value : null;
}

export async function setSetting(key: string, value: unknown, db: Db = pool()): Promise<void> {
  await q("INSERT INTO settings (key, value) VALUES ($1, $2) ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value", [key, JSON.stringify(value)], db);
}
