// Test database helper: uses the farpost_test database and starts each file from an empty schema.
import fs from "node:fs";
import path from "node:path";

process.env.DATABASE_URL = process.env.TEST_DATABASE_URL ?? "postgres://farpost:farpost@localhost:5432/farpost_test";
process.env.FOOTBALL_PROVIDER = "mock";
process.env.ADMIN_EMAILS = "ben@example.com";
process.env.RESEND_API_KEY = "";

import { pool, q } from "@/lib/db";

export async function resetDb() {
  const db = pool();
  await db.query("DROP SCHEMA public CASCADE; CREATE SCHEMA public;");
  const dir = path.join(__dirname, "..", "..", "migrations");
  for (const f of fs.readdirSync(dir).filter((x) => x.endsWith(".sql")).sort()) await db.query(fs.readFileSync(path.join(dir, f), "utf8"));
}

export async function closeDb() {
  await pool().end();
  globalThis.__farpostPool = undefined;
}

export const at = (s: string) => new Date(s);

export async function addClub(code: string): Promise<number> {
  return (await q<{ id: number }>("INSERT INTO clubs (provider_id, name, short_name) VALUES ($1,$2,$3) RETURNING id", [code, `Club ${code}`, code]))[0].id;
}

export async function addPlayer(providerId: string, clubId: number, position: string, price = 6): Promise<number> {
  return (await q<{ id: number }>("INSERT INTO players (provider_id, club_id, name, position, price, published, approved) VALUES ($1,$2,$1,$3,$4,true,true) RETURNING id", [providerId, clubId, position, price]))[0].id;
}

export async function addUser(email: string, joinedWeek: number | null = 1): Promise<number> {
  return (await q<{ id: number }>("INSERT INTO users (email, team_name, joined_week) VALUES ($1,$1,$2) RETURNING id", [email, joinedWeek]))[0].id;
}
