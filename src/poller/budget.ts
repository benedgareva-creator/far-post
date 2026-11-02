// Request budget and pacing rules for the poller (spec section 5). Pure functions.

export interface BudgetState {
  dayLimit: number; // requests allowed per UTC day
  minuteLimit: number; // requests allowed per minute
  usedToday: number; // counted across restarts (from the database), or the supplier's own figure if higher
}

export type LiveMode = "normal" | "slow" | "slower" | "stopped";

export interface Pacing {
  /** Seconds between live fetches. */
  liveIntervalSec: number;
  mode: LiveMode;
  /** Minimum milliseconds between any two calls (including retries). */
  minGapMs: number;
  /** Whether correction rechecks may still run. */
  correctionsAllowed: boolean;
}

export const BASE_LIVE_INTERVAL_SEC = 60;

/**
 * - Space calls at most one a second and at most half the minute allowance (Free: five a minute).
 * - At 80% of the day's allowance fetch every two minutes, at 90% every five, at 95% stop live fetching
 *   but keep the remainder for corrections.
 */
export function pacing(b: BudgetState): Pacing {
  const perMinute = Math.max(1, Math.min(60, Math.floor(b.minuteLimit / 2)));
  const minGapMs = Math.max(1000, Math.ceil(60_000 / perMinute));
  const used = b.dayLimit > 0 ? b.usedToday / b.dayLimit : 1;
  if (used >= 0.95) return { liveIntervalSec: Infinity, mode: "stopped", minGapMs, correctionsAllowed: b.usedToday < b.dayLimit };
  if (used >= 0.9) return { liveIntervalSec: 300, mode: "slower", minGapMs, correctionsAllowed: true };
  if (used >= 0.8) return { liveIntervalSec: 120, mode: "slow", minGapMs, correctionsAllowed: true };
  return { liveIntervalSec: BASE_LIVE_INTERVAL_SEC, mode: "normal", minGapMs, correctionsAllowed: true };
}

/** Increasing waits after "too many requests" replies: 30s, 60s, 120s ... capped at 15 minutes. */
export function backoffMs(consecutiveLimitReplies: number): number {
  if (consecutiveLimitReplies <= 0) return 0;
  return Math.min(15 * 60_000, 30_000 * 2 ** (consecutiveLimitReplies - 1));
}

/** Expected daily use (spec section 5) for a plan check on the Health page. */
export function expectedDailyCalls(opts: { activeMinutes: number; matchMinutes: number; batch: boolean; background?: number }): number {
  const bg = opts.background ?? 112;
  const live = opts.batch ? opts.activeMinutes : opts.activeMinutes + 2 * opts.matchMinutes;
  return Math.ceil((live + bg) * 1.2);
}
