// A team's points for one Week: doubles, auto-substitutes, captain and vice-captain.
// Pure function (spec section 2).
import { MIN_STARTERS, STARTERS, type Position } from "../game/rules";

export type PointsStatus = "live" | "provisional" | "final";

export interface PlayerWeekFixture {
  fixtureId: number;
  points: number;
  minutes: number;
  /** Has this match finished (or been voided) so the player's participation is known? */
  resolved: boolean;
  status: PointsStatus;
  pending: boolean;
}

export interface TeamPick {
  playerId: number;
  position: Position;
  slot: number; // 1-11 start, 12 reserve GK, 13-14 bench order
  isCaptain: boolean;
  isVice: boolean;
}

export interface TeamWeekResult {
  points: number;
  status: PointsStatus;
  partial: boolean; // live or with pending measures
  players: {
    playerId: number;
    slot: number;
    counted: boolean; // in the final eleven
    multiplier: number; // 0 bench, 1, or 2 for the acting captain
    points: number; // raw points before captain multiplier
    minutes: number;
    played: boolean;
    resolved: boolean;
    subbedIn: boolean;
    subbedOut: boolean;
  }[];
  actingCaptain: number | null;
  notes: string[];
}

interface Agg {
  points: number;
  minutes: number;
  resolved: boolean; // every match this week resolved (a blank Week counts as resolved)
  status: PointsStatus;
  pending: boolean;
}

const STATUS_ORDER: PointsStatus[] = ["live", "provisional", "final"];
const worst = (a: PointsStatus, b: PointsStatus) => (STATUS_ORDER.indexOf(a) < STATUS_ORDER.indexOf(b) ? a : b);

function aggregate(fixtures: PlayerWeekFixture[] | undefined): Agg {
  const list = fixtures ?? [];
  return {
    points: list.reduce((s, f) => s + f.points, 0),
    minutes: list.reduce((s, f) => s + f.minutes, 0),
    resolved: list.every((f) => f.resolved),
    status: list.reduce<PointsStatus>((s, f) => worst(s, f.status), "final"),
    pending: list.some((f) => f.pending),
  };
}

function formationOk(positions: Position[]): boolean {
  const c = (p: Position) => positions.filter((x) => x === p).length;
  return c("GK") === 1 && c("DEF") >= MIN_STARTERS.DEF && c("MID") >= MIN_STARTERS.MID && c("FWD") >= MIN_STARTERS.FWD;
}

/**
 * @param picks  the 14 locked picks for the Week
 * @param fixturesByPlayer every match each player has in the Week (doubles have two, blanks none)
 * @param weekHasFixtures false when the Week has no scored matches at all yet
 */
export function scoreTeamWeek(picks: TeamPick[], fixturesByPlayer: Map<number, PlayerWeekFixture[]>): TeamWeekResult {
  const agg = new Map<number, Agg>();
  for (const p of picks) agg.set(p.playerId, aggregate(fixturesByPlayer.get(p.playerId)));
  const a = (id: number) => agg.get(id)!;
  const notes: string[] = [];

  const sorted = [...picks].sort((x, y) => x.slot - y.slot);
  const eleven = sorted.filter((p) => p.slot <= STARTERS);
  const reserveGk = sorted.find((p) => p.slot === 12);
  const bench = sorted.filter((p) => p.slot >= 13);
  const usedBench = new Set<number>();
  const subbedOut = new Set<number>();
  const subbedIn = new Set<number>();
  const final = [...eleven];

  const nonPlaying = (id: number) => a(id).resolved && a(id).minutes === 0;
  const played = (id: number) => a(id).minutes > 0;

  for (const starter of eleven) {
    if (!nonPlaying(starter.playerId)) continue;
    if (starter.position === "GK") {
      if (reserveGk && played(reserveGk.playerId)) {
        swap(starter, reserveGk);
      } else if (reserveGk && !a(reserveGk.playerId).resolved) {
        notes.push("Waiting to see if the reserve goalkeeper plays.");
      }
      continue;
    }
    for (const cand of bench) {
      if (usedBench.has(cand.playerId)) continue;
      const cd = a(cand.playerId);
      if (!played(cand.playerId)) {
        if (cd.resolved) continue; // did not play: try the next bench player
        notes.push("Waiting for a bench player's match before making a substitution.");
        break; // bench order is strict: wait rather than skip someone who may still play
      }
      const trial = final.map((p) => (p.playerId === starter.playerId ? cand : p)).map((p) => p.position);
      if (!formationOk(trial)) continue;
      swap(starter, cand);
      break;
    }
  }

  function swap(out: TeamPick, inn: TeamPick) {
    const i = final.findIndex((p) => p.playerId === out.playerId);
    final[i] = inn;
    usedBench.add(inn.playerId);
    subbedOut.add(out.playerId);
    subbedIn.add(inn.playerId);
  }

  // Captain doubles; the vice-captain takes over only when the captain has zero minutes.
  const captain = picks.find((p) => p.isCaptain) ?? null;
  const vice = picks.find((p) => p.isVice) ?? null;
  let actingCaptain: number | null = captain?.playerId ?? null;
  if (captain && nonPlaying(captain.playerId)) {
    actingCaptain = vice && final.some((p) => p.playerId === vice.playerId) && !nonPlaying(vice.playerId) ? vice.playerId : null;
    notes.push(actingCaptain ? "Captain did not play: vice-captain's points doubled." : "Neither captain nor vice-captain played.");
  }

  const finalIds = new Set(final.map((p) => p.playerId));
  let points = 0;
  let status = "final" as PointsStatus;
  let partial = false;
  const players = sorted.map((p) => {
    const d = a(p.playerId);
    const counted = finalIds.has(p.playerId);
    const multiplier = !counted ? 0 : p.playerId === actingCaptain ? 2 : 1;
    if (counted) {
      points += d.points * multiplier;
      if (d.pending) partial = true;
    }
    status = worst(status, d.status);
    return {
      playerId: p.playerId,
      slot: p.slot,
      counted,
      multiplier,
      points: d.points,
      minutes: d.minutes,
      played: d.minutes > 0,
      resolved: d.resolved,
      subbedIn: subbedIn.has(p.playerId),
      subbedOut: subbedOut.has(p.playerId),
    };
  });
  if (status === "live") partial = true;
  return { points, status, partial, players, actingCaptain, notes: [...new Set(notes)] };
}
