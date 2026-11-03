// Squads, transfers, lineups and deadlines. Every rule is enforced here on the server.
import type { PoolClient } from "pg";
import { one, q, tx, type Db, pool } from "../db";
import { BUDGET, defaultLineup, transfersAllowed, validateLineup, validateSquad, type LineupEntry, type Position, type SquadPlayer } from "../game/rules";
import { rulesForWeek } from "./scoring";

export class GameError extends Error {}

export interface WeekRow {
  number: number;
  deadline: Date;
  frozen: boolean;
  locked: boolean;
  status: string;
  ruleset_id: number | null;
}

export async function upcomingWeek(now: Date, db: Db = pool()): Promise<WeekRow | null> {
  return one<WeekRow>("SELECT * FROM weeks WHERE deadline > $1 ORDER BY number LIMIT 1", [now], db);
}

export async function currentWeek(now: Date, db: Db = pool()): Promise<WeekRow | null> {
  return one<WeekRow>("SELECT * FROM weeks WHERE deadline <= $1 ORDER BY number DESC LIMIT 1", [now], db);
}

/** Locks every Week whose deadline has passed: snapshots each team's lineup and fixes the rules. */
export async function lockDueWeeks(now: Date, db: Db = pool()): Promise<number[]> {
  const due = await q<{ number: number }>("SELECT number FROM weeks WHERE deadline <= $1 AND NOT locked ORDER BY number", [now], db);
  const done: number[] = [];
  for (const w of due) {
    await tx(async (c) => {
      const row = await one<{ locked: boolean }>("SELECT locked FROM weeks WHERE number = $1 FOR UPDATE", [w.number], c);
      if (!row || row.locked) return;
      const { id: rulesetId } = await rulesForWeek(w.number, c);
      // Teams carry forward: the editable lineup becomes this Week's locked lineup.
      await q(
        `INSERT INTO picks (user_id, week_number, player_id, slot, is_captain, is_vice, price)
         SELECT k.user_id, $1, k.player_id, k.slot, k.is_captain, k.is_vice, k.price
           FROM picks k JOIN users u ON u.id = k.user_id
          WHERE k.week_number IS NULL AND u.joined_week IS NOT NULL AND u.joined_week <= $1
            AND (SELECT count(*) FROM picks z WHERE z.user_id = k.user_id AND z.week_number IS NULL) = 14
            AND NOT EXISTS (SELECT 1 FROM picks d WHERE d.user_id = k.user_id AND d.week_number = $1)
         ON CONFLICT DO NOTHING`,
        [w.number],
        c,
      );
      await q("UPDATE weeks SET locked = true, frozen = true, ruleset_id = $2, status = 'live' WHERE number = $1", [w.number, rulesetId], c);
    });
    done.push(w.number);
  }
  return done;
}

/**
 * Before one team's editable lineup changes, copy it into every Week whose deadline has passed but
 * which the poller has not locked yet. Without this, an edit made for next Week in the gap between a
 * deadline and the poller's lock (or during a poller outage) would leak into the Week already closed.
 */
async function snapshotOverdueWeeks(c: PoolClient, userId: number, now: Date) {
  await q(
    `INSERT INTO picks (user_id, week_number, player_id, slot, is_captain, is_vice, price)
     SELECT k.user_id, w.number, k.player_id, k.slot, k.is_captain, k.is_vice, k.price
       FROM weeks w
       JOIN users u ON u.id = $1 AND u.joined_week IS NOT NULL AND u.joined_week <= w.number
       JOIN picks k ON k.user_id = u.id AND k.week_number IS NULL
      WHERE w.deadline <= $2 AND NOT w.locked
        AND (SELECT count(*) FROM picks z WHERE z.user_id = u.id AND z.week_number IS NULL) = 14
        AND NOT EXISTS (SELECT 1 FROM picks d WHERE d.user_id = u.id AND d.week_number = w.number)
     ON CONFLICT DO NOTHING`,
    [userId, now],
    c,
  );
}

/**
 * Opens an edit: takes the team's row lock (every squad or lineup change takes it first, so edits to
 * one team run one at a time), protects overdue Weeks, then finds the upcoming Week and refuses edits
 * after its deadline. The clock is re-read after the lock is held, so a request that waited on the
 * lock across a deadline is refused.
 */
async function openWeekForEdit(c: PoolClient, requestedAt: Date, userId: number): Promise<WeekRow> {
  const waitStart = Date.now();
  const u = await one("SELECT id FROM users WHERE id = $1 FOR UPDATE", [userId], c);
  if (!u) throw new GameError("Sign in again.");
  const now = new Date(requestedAt.getTime() + (Date.now() - waitStart));
  await snapshotOverdueWeeks(c, userId, now);
  const w = await one<WeekRow>("SELECT * FROM weeks WHERE deadline > $1 ORDER BY number LIMIT 1 FOR SHARE", [now], c);
  if (!w) throw new GameError("There is no upcoming Week to edit.");
  if (w.locked || w.deadline.getTime() <= now.getTime()) throw new GameError("The deadline has passed.");
  return w;
}

interface PlayerRow {
  id: number;
  position: Position;
  club_id: number;
  price: number | null;
  published: boolean;
  approved: boolean;
}

async function loadPlayers(ids: number[], c: Db): Promise<PlayerRow[]> {
  return q<PlayerRow>("SELECT id, position, club_id, price, published, approved FROM players WHERE id = ANY($1::int[])", [ids], c);
}

function buyable(p: PlayerRow | undefined): p is PlayerRow & { price: number } {
  return !!p && p.published && p.approved && p.price !== null;
}

/** First squad for a new team. Late joiners start at the next deadline. */
export async function createSquad(userId: number, playerIds: number[], now: Date) {
  return tx(
    async (c) => {
      const week = await openWeekForEdit(c, now, userId);
      const has = await one("SELECT 1 FROM squad_players WHERE user_id = $1 LIMIT 1", [userId], c);
      if (has) throw new GameError("You already have a squad. Use transfers to change it.");
      const unique = [...new Set(playerIds)];
      const rows = await loadPlayers(unique, c);
      if (rows.length !== playerIds.length || !rows.every(buyable)) throw new GameError("Some of those players are not available.");
      const squad: SquadPlayer[] = rows.map((p) => ({ id: p.id, position: p.position, clubId: p.club_id, price: p.price! }));
      const errors = validateSquad(squad);
      if (errors.length) throw new GameError(errors.join(" "));
      for (const p of squad) await q("INSERT INTO squad_players (user_id, player_id, purchase_price) VALUES ($1,$2,$3)", [userId, p.id, p.price], c);
      const lineup = defaultLineup(squad);
      await writeLineup(c, userId, lineup, new Map(squad.map((p) => [p.id, p.price])));
      await q("UPDATE users SET joined_week = COALESCE(joined_week, $2) WHERE id = $1", [userId, week.number], c);
      return { week: week.number };
    },
    { serializable: true },
  );
}

async function writeLineup(c: PoolClient, userId: number, lineup: LineupEntry[], prices: Map<number, number>) {
  await q("DELETE FROM picks WHERE user_id = $1 AND week_number IS NULL", [userId], c);
  for (const e of lineup) {
    await q(
      "INSERT INTO picks (user_id, week_number, player_id, slot, is_captain, is_vice, price) VALUES ($1, NULL, $2, $3, $4, $5, $6)",
      [userId, e.playerId, e.slot, e.isCaptain, e.isVice, prices.get(e.playerId) ?? 0],
      c,
    );
  }
}

export async function transferStatus(userId: number, now: Date, db: Db = pool()) {
  const user = await one<{ joined_week: number | null }>("SELECT joined_week FROM users WHERE id = $1", [userId], db);
  const week = await upcomingWeek(now, db);
  if (!user || !week) return { week: null, remaining: 0 as number | null, freePeriod: false, bank: 0 };
  const freePeriod = user.joined_week === null || user.joined_week >= week.number;
  const made = await one<{ n: string }>("SELECT count(*) AS n FROM transfers WHERE user_id = $1 AND week_number = $2 AND NOT free_period", [userId, week.number], db);
  const spent = await one<{ s: string | null }>("SELECT sum(purchase_price) AS s FROM squad_players WHERE user_id = $1", [userId], db);
  return {
    week: week.number,
    freePeriod,
    remaining: transfersAllowed({ teamHasPlayedADeadline: !freePeriod, madeThisWeek: Number(made?.n ?? 0) }),
    bank: BUDGET - Number(spent?.s ?? 0),
  };
}

/**
 * Swap players. Each incoming player takes the outgoing player's lineup place, so positions must match.
 * Selling returns the purchase price. Runs serializably so two simultaneous requests cannot both
 * spend the same budget or the same weekly transfers.
 */
export async function makeTransfers(userId: number, swaps: { out: number; in: number }[], now: Date) {
  if (swaps.length === 0) throw new GameError("Choose at least one transfer.");
  return tx(
    async (c) => {
      const week = await openWeekForEdit(c, now, userId);
      const user = await one<{ joined_week: number | null }>("SELECT joined_week FROM users WHERE id = $1", [userId], c);
      const owned = await q<{ player_id: number; purchase_price: number }>("SELECT player_id, purchase_price FROM squad_players WHERE user_id = $1", [userId], c);
      if (owned.length === 0) throw new GameError("Pick your squad first.");
      const freePeriod = user!.joined_week === null || user!.joined_week >= week.number;
      const made = await one<{ n: string }>("SELECT count(*) AS n FROM transfers WHERE user_id = $1 AND week_number = $2 AND NOT free_period", [userId, week.number], c);
      const left = transfersAllowed({ teamHasPlayedADeadline: !freePeriod, madeThisWeek: Number(made?.n ?? 0) });
      if (left !== null && swaps.length > left) throw new GameError(left === 0 ? "You have no transfers left this Week." : `You have only ${left} transfer${left === 1 ? "" : "s"} left this Week.`);

      const outIds = swaps.map((s) => s.out), inIds = swaps.map((s) => s.in);
      if (new Set(outIds).size !== outIds.length || new Set(inIds).size !== inIds.length) throw new GameError("Each player can only move once.");
      const ownedIds = new Set(owned.map((o) => o.player_id));
      if (!outIds.every((id) => ownedIds.has(id))) throw new GameError("You can only sell players you own.");
      if (inIds.some((id) => ownedIds.has(id) && !outIds.includes(id))) throw new GameError("You already own one of those players.");

      const all = await loadPlayers([...new Set([...owned.map((o) => o.player_id), ...inIds])], c);
      const byId = new Map(all.map((p) => [p.id, p]));
      for (const s of swaps) {
        const pin = byId.get(s.in);
        if (!buyable(pin)) throw new GameError("One of those players is not available.");
        if (pin.position !== byId.get(s.out)!.position) throw new GameError("Swap players in the same position.");
      }
      const priceOf = new Map(owned.map((o) => [o.player_id, o.purchase_price]));
      const after: SquadPlayer[] = [
        ...owned.filter((o) => !outIds.includes(o.player_id)).map((o) => ({ id: o.player_id, position: byId.get(o.player_id)!.position, clubId: byId.get(o.player_id)!.club_id, price: o.purchase_price })),
        ...inIds.map((id) => ({ id, position: byId.get(id)!.position, clubId: byId.get(id)!.club_id, price: byId.get(id)!.price! })),
      ];
      const bought = after.filter((p) => inIds.includes(p.id));
      const errors = validateSquad(after, { checkClubLimit: bought });
      if (errors.length) throw new GameError(errors.join(" "));

      for (const s of swaps) {
        const pin = byId.get(s.in)!;
        await q("DELETE FROM squad_players WHERE user_id = $1 AND player_id = $2", [userId, s.out], c);
        await q("INSERT INTO squad_players (user_id, player_id, purchase_price) VALUES ($1,$2,$3)", [userId, s.in, pin.price], c);
        await q("UPDATE picks SET player_id = $3, price = $4 WHERE user_id = $1 AND week_number IS NULL AND player_id = $2", [userId, s.out, s.in, pin.price], c);
        await q(
          "INSERT INTO transfers (user_id, week_number, player_out, player_in, price_out, price_in, free_period) VALUES ($1,$2,$3,$4,$5,$6,$7)",
          [userId, week.number, s.out, s.in, priceOf.get(s.out), pin.price, freePeriod],
          c,
        );
      }
      return { week: week.number };
    },
    { serializable: true },
  );
}

/** Save the starting eleven, bench order, captain and vice-captain for the next deadline. */
export async function saveLineup(userId: number, entries: { playerId: number; slot: number; isCaptain: boolean; isVice: boolean }[], now: Date) {
  return tx(async (c) => {
    await openWeekForEdit(c, now, userId);
    const owned = await q<{ player_id: number; purchase_price: number; position: Position }>(
      "SELECT s.player_id, s.purchase_price, p.position FROM squad_players s JOIN players p ON p.id = s.player_id WHERE s.user_id = $1",
      [userId],
      c,
    );
    const pos = new Map(owned.map((o) => [o.player_id, o.position]));
    if (entries.length !== owned.length || !entries.every((e) => pos.has(e.playerId))) throw new GameError("The lineup must use exactly your squad.");
    const lineup: LineupEntry[] = entries.map((e) => ({ ...e, position: pos.get(e.playerId)! }));
    const errors = validateLineup(lineup);
    if (errors.length) throw new GameError(errors.join(" "));
    await writeLineup(c, userId, lineup, new Map(owned.map((o) => [o.player_id, o.purchase_price])));
  }, { serializable: true });
}
