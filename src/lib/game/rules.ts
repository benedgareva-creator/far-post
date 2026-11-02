// Squad, lineup and transfer rules (spec section 2). Pure functions, no database.

export type Position = "GK" | "DEF" | "MID" | "FWD";
export const POSITIONS: Position[] = ["GK", "DEF", "MID", "FWD"];
export const POSITION_NAMES: Record<Position, string> = {
  GK: "Goalkeeper",
  DEF: "Defender",
  MID: "Midfielder",
  FWD: "Forward",
};

export const SQUAD_SIZE = 14;
export const SQUAD_SHAPE: Record<Position, number> = { GK: 2, DEF: 4, MID: 5, FWD: 3 };
export const BUDGET = 100;
export const MAX_PER_CLUB = 3;
export const STARTERS = 11;
export const MIN_STARTERS: Record<Position, number> = { GK: 1, DEF: 3, MID: 3, FWD: 1 };
export const WEEKLY_TRANSFERS = 2;
export const PRICES = [4, 6, 8, 10] as const;

export interface SquadPlayer {
  id: number;
  position: Position;
  clubId: number;
  price: number; // purchase price for owned players, current price for new ones
}

export function squadCost(players: SquadPlayer[]): number {
  return players.reduce((sum, p) => sum + p.price, 0);
}

/** Problems with a full squad, as plain-English messages. Empty = valid. */
export function validateSquad(players: SquadPlayer[], opts: { checkClubLimit?: SquadPlayer[] } = {}): string[] {
  const errors: string[] = [];
  const ids = new Set(players.map((p) => p.id));
  if (ids.size !== players.length) errors.push("A player appears twice.");
  if (players.length !== SQUAD_SIZE) errors.push(`A squad needs exactly ${SQUAD_SIZE} players.`);
  for (const pos of POSITIONS) {
    const n = players.filter((p) => p.position === pos).length;
    if (n !== SQUAD_SHAPE[pos]) errors.push(`You need ${SQUAD_SHAPE[pos]} ${POSITION_NAMES[pos].toLowerCase()}s (you have ${n}).`);
  }
  const cost = squadCost(players);
  if (cost > BUDGET) errors.push(`The squad costs ${cost}, over the ${BUDGET} budget.`);
  // The three-per-club rule applies when buying: only the newly bought players are checked
  // against the resulting squad, so a squad that later exceeds it (players moving clubs) is not punished.
  const bought = opts.checkClubLimit ?? players;
  const clubCounts = new Map<number, number>();
  for (const p of players) clubCounts.set(p.clubId, (clubCounts.get(p.clubId) ?? 0) + 1);
  const overClubs = new Set(bought.filter((p) => (clubCounts.get(p.clubId) ?? 0) > MAX_PER_CLUB).map((p) => p.clubId));
  if (overClubs.size > 0) errors.push(`You can have at most ${MAX_PER_CLUB} players from one club.`);
  return errors;
}

export interface LineupEntry {
  playerId: number;
  position: Position;
  slot: number; // 1-11 start, 12 reserve GK, 13-14 outfield bench in order
  isCaptain: boolean;
  isVice: boolean;
}

/** Checks the starting eleven and bench layout. Empty = valid. */
export function validateLineup(entries: LineupEntry[]): string[] {
  const errors: string[] = [];
  if (entries.length !== SQUAD_SIZE) return [`A lineup must include all ${SQUAD_SIZE} squad players.`];
  const slots = entries.map((e) => e.slot).sort((a, b) => a - b);
  if (slots.join(",") !== Array.from({ length: SQUAD_SIZE }, (_, i) => i + 1).join(",")) errors.push("Every position in the lineup must be filled once.");
  const starters = entries.filter((e) => e.slot <= STARTERS);
  const count = (pos: Position) => starters.filter((e) => e.position === pos).length;
  if (count("GK") !== 1) errors.push("Start exactly one goalkeeper.");
  if (count("DEF") < MIN_STARTERS.DEF) errors.push("Start at least 3 defenders.");
  if (count("MID") < MIN_STARTERS.MID) errors.push("Start at least 3 midfielders.");
  if (count("FWD") < MIN_STARTERS.FWD) errors.push("Start at least 1 forward.");
  const reserveGk = entries.find((e) => e.slot === 12);
  if (!reserveGk || reserveGk.position !== "GK") errors.push("The first bench place is for your reserve goalkeeper.");
  const caps = entries.filter((e) => e.isCaptain);
  const vices = entries.filter((e) => e.isVice);
  if (caps.length !== 1) errors.push("Choose one captain.");
  if (vices.length !== 1) errors.push("Choose one vice-captain.");
  if (caps[0] && vices[0] && caps[0].playerId === vices[0].playerId) errors.push("Captain and vice-captain must be different players.");
  if (caps[0] && caps[0].slot > STARTERS) errors.push("Your captain must be in the starting eleven.");
  if (vices[0] && vices[0].slot > STARTERS) errors.push("Your vice-captain must be in the starting eleven.");
  return errors;
}

/** Builds a valid default lineup from a squad: best formation 4-4-2 style, cheapest on the bench. */
export function defaultLineup(players: { id: number; position: Position; price: number }[]): LineupEntry[] {
  const by = (pos: Position) => players.filter((p) => p.position === pos).sort((a, b) => b.price - a.price || a.id - b.id);
  const gk = by("GK"), def = by("DEF"), mid = by("MID"), fwd = by("FWD");
  // 1 GK, 4 DEF, 4 MID, 2 FWD = 11. Bench: GK, MID, FWD.
  const starters = [gk[0], ...def.slice(0, 4), ...mid.slice(0, 4), ...fwd.slice(0, 2)];
  const bench = [mid[4], fwd[2]];
  const entries: LineupEntry[] = starters.map((p, i) => ({ playerId: p.id, position: p.position, slot: i + 1, isCaptain: false, isVice: false }));
  entries.push({ playerId: gk[1].id, position: "GK", slot: 12, isCaptain: false, isVice: false });
  bench.forEach((p, i) => entries.push({ playerId: p.id, position: p.position, slot: 13 + i, isCaptain: false, isVice: false }));
  const outfieldStarters = entries.filter((e) => e.slot <= 11 && e.position !== "GK");
  const priced = outfieldStarters
    .map((e) => ({ e, price: players.find((p) => p.id === e.playerId)!.price }))
    .sort((a, b) => b.price - a.price || a.e.playerId - b.e.playerId);
  priced[0].e.isCaptain = true;
  priced[1].e.isVice = true;
  return entries;
}

/**
 * How many transfers are still allowed for the coming deadline.
 * Before a team's first deadline: unlimited (null). After: two a week, no carry-over.
 */
export function transfersAllowed(opts: { teamHasPlayedADeadline: boolean; madeThisWeek: number }): number | null {
  if (!opts.teamHasPlayedADeadline) return null;
  return Math.max(0, WEEKLY_TRANSFERS - opts.madeThisWeek);
}
