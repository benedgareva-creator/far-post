import crypto from "node:crypto";
import { one, q } from "../db";
import { GameError } from "./teams";

const ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789"; // no 0/O/1/I confusion

export function inviteCode(): string {
  const bytes = crypto.randomBytes(8);
  return Array.from(bytes, (b) => ALPHABET[b % ALPHABET.length]).join("");
}

export async function createLeague(userId: number, name: string, startWeek: number) {
  const clean = name.trim().slice(0, 50);
  if (clean.length < 2) throw new GameError("League names need at least 2 characters.");
  const exists = await one("SELECT 1 FROM weeks WHERE number = $1", [startWeek]);
  if (!exists) throw new GameError("Choose a Week that exists.");
  const league = await one<{ id: number; code: string }>("INSERT INTO leagues (name, code, owner_id, start_week) VALUES ($1,$2,$3,$4) RETURNING id, code", [clean, inviteCode(), userId, startWeek]);
  await q("INSERT INTO league_members (league_id, user_id) VALUES ($1,$2)", [league!.id, userId]);
  return league!;
}

export async function joinLeague(userId: number, code: string) {
  const league = await one<{ id: number }>("SELECT id FROM leagues WHERE code = $1", [code.trim().toUpperCase()]);
  if (!league) throw new GameError("No league has that code.");
  await q("INSERT INTO league_members (league_id, user_id) VALUES ($1,$2) ON CONFLICT DO NOTHING", [league.id, userId]);
  return league;
}

export async function leaveLeague(userId: number, leagueId: number) {
  await q("DELETE FROM league_members WHERE league_id = $1 AND user_id = $2", [leagueId, userId]);
}
