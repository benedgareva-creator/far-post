// Week timing (spec section 2). Pure functions.
// - A Week runs from its deadline to the next Week's deadline.
// - Deadline = one hour before the round's first scheduled kickoff.
// - Deadlines follow schedule changes until seven days away, then freeze.
// - A match counts in the Week that contains its actual kickoff; once started it keeps that Week
//   (so a suspended match that resumes later stays in its original Week).
// - Postponed matches without a new date belong to no Week; abandoned matches are void.

export const DEADLINE_BEFORE_KICKOFF_MS = 60 * 60 * 1000;
export const FREEZE_BEFORE_DEADLINE_MS = 7 * 24 * 60 * 60 * 1000;

export const NOT_SCHEDULED = new Set(["PST", "TBD", "CANC"]);
export const VOID = new Set(["ABD", "CANC", "AWD", "WO"]);
export const LIVE = new Set(["1H", "HT", "2H", "ET", "BT", "P", "LIVE", "SUSP", "INT"]);
export const FINISHED = new Set(["FT", "AET", "PEN"]);

export interface RoundFixture {
  kickoff: Date;
  status: string;
}

export interface WeekTiming {
  number: number;
  deadline: Date;
  frozen: boolean;
}

/** Recompute a Week's deadline from its round, respecting the seven-day freeze. */
export function nextDeadline(current: WeekTiming | null, round: RoundFixture[], now: Date): { deadline: Date; frozen: boolean } | null {
  if (current?.frozen) return { deadline: current.deadline, frozen: true };
  // The stored deadline is what managers were told. Once it is within seven days it is fixed, even if
  // the round has since moved: check this before looking at the new schedule.
  if (current && shouldFreeze(current.deadline, now)) return { deadline: current.deadline, frozen: true };
  const scheduled = round.filter((f) => !NOT_SCHEDULED.has(f.status)).map((f) => f.kickoff.getTime());
  if (scheduled.length === 0) return current ? { deadline: current.deadline, frozen: current.frozen } : null;
  const deadline = new Date(Math.min(...scheduled) - DEADLINE_BEFORE_KICKOFF_MS);
  return { deadline, frozen: shouldFreeze(deadline, now) };
}

export function shouldFreeze(deadline: Date, now: Date): boolean {
  return deadline.getTime() - now.getTime() <= FREEZE_BEFORE_DEADLINE_MS;
}

/** Which Week a kickoff falls in, given Weeks sorted by number. null = before Week 1. */
export function weekForKickoff(kickoff: Date, weeks: WeekTiming[]): number | null {
  let found: number | null = null;
  for (const w of [...weeks].sort((a, b) => a.number - b.number)) {
    if (kickoff.getTime() >= w.deadline.getTime()) found = w.number;
    else break;
  }
  return found;
}

/**
 * Assign a fixture to a Week. weekFixed is set the first time the match is seen started (with the
 * kickoff from that same update), so a match keeps that Week through suspensions and resumptions,
 * but a Week guessed while it was only scheduled is never kept if the kickoff moved.
 */
export function assignFixtureWeek(
  f: { kickoff: Date; status: string; weekFixed: boolean; currentWeek: number | null },
  weeks: WeekTiming[],
): number | null {
  if (f.weekFixed && f.currentWeek !== null) return f.currentWeek;
  if (NOT_SCHEDULED.has(f.status)) return null;
  return weekForKickoff(f.kickoff, weeks);
}

/** The Week whose deadline is next (the one teams are currently editing). */
export function upcomingWeek(weeks: WeekTiming[], now: Date): WeekTiming | null {
  return [...weeks].sort((a, b) => a.number - b.number).find((w) => w.deadline.getTime() > now.getTime()) ?? null;
}

/** The latest Week whose deadline has passed (the one being played / scored). */
export function currentWeek(weeks: WeekTiming[], now: Date): WeekTiming | null {
  const past = [...weeks].sort((a, b) => a.number - b.number).filter((w) => w.deadline.getTime() <= now.getTime());
  return past[past.length - 1] ?? null;
}
