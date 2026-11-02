// The poller: the one server program that talks to the football data supplier for everyone.
// It fetches live matches every 60 seconds (slower when the daily budget runs low),
// rechecks finished matches after 30 minutes, 24 hours and 72 hours, keeps the fixture
// list and squads fresh once a day, and raises alerts for Ben.
import { getSetting, one, q, setSetting, type Db, pool } from "../lib/db";
import { FINISHED, LIVE } from "../lib/game/weeks";
import type { CallMeta, FootballProvider } from "../lib/provider/types";
import { raiseAlert, resolveAlert } from "../lib/services/alerts";
import { rescoreFixture, rescoreWeek } from "../lib/services/scoring";
import { storeDetail, syncCatalogue, syncFixtures } from "../lib/services/sync";
import { lockDueWeeks } from "../lib/services/teams";
import { refreshSuggestions } from "../lib/services/admin";
import { backoffMs, pacing, type Pacing } from "./budget";

export const MATCH_WINDOW_MIN = 180; // allow 180 minutes per match
export const RECHECKS_MIN = [30, 24 * 60, 72 * 60];
export const STALE_WARNING_MS = 3 * 60_000;

export interface PollerDeps {
  provider: FootballProvider;
  db?: Db;
  now: () => Date;
  sleep?: (ms: number) => Promise<void>;
  log?: (msg: string) => void;
  limits: { day: number; minute: number };
}

export type Purpose = "live" | "background" | "correction";

export class Poller {
  private db: Db;
  private log: (m: string) => void;
  private sleep: (ms: number) => Promise<void>;
  private lastCallAt = 0;
  private lastLiveAt = 0;
  private limitReplies = 0;
  private waitUntil = 0;
  private minuteLimit: number;
  private dayLimit: number;

  constructor(private deps: PollerDeps) {
    this.db = deps.db ?? pool();
    this.log = deps.log ?? ((m) => console.log(`[poller ${new Date().toISOString()}] ${m}`));
    this.sleep = deps.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms)));
    this.dayLimit = deps.limits.day;
    this.minuteLimit = deps.limits.minute;
    deps.provider.throttle = () => this.throttle();
  }

  /** Requests made today (UTC), counted in the database so restarts do not reset it. */
  async usedToday(): Promise<number> {
    const day = this.deps.now().toISOString().slice(0, 10);
    const row = await one<{ n: string; reported: number | null; lim: number | null }>(
      `SELECT count(*) AS n,
              (SELECT day_remaining FROM api_requests WHERE utc_day = $1 AND day_remaining IS NOT NULL ORDER BY id DESC LIMIT 1) AS reported,
              (SELECT day_limit FROM api_requests WHERE utc_day = $1 AND day_limit IS NOT NULL ORDER BY id DESC LIMIT 1) AS lim
         FROM api_requests WHERE utc_day = $1`,
      [day],
      this.db,
    );
    const counted = Number(row?.n ?? 0);
    // Trust whichever is higher: our own count or what the supplier reports.
    const reported = row?.reported != null && row?.lim != null ? row.lim - row.reported : 0;
    return Math.max(counted, reported);
  }

  async pacing(): Promise<Pacing> {
    return pacing({ dayLimit: this.dayLimit, minuteLimit: this.minuteLimit, usedToday: await this.usedToday() });
  }

  private async throttle() {
    const p = await this.pacing();
    const wait = Math.max(this.lastCallAt + p.minGapMs - this.deps.now().getTime(), this.waitUntil - this.deps.now().getTime(), 0);
    if (wait > 0) await this.sleep(wait);
    this.lastCallAt = this.deps.now().getTime();
  }

  private async record(calls: CallMeta[], purpose: Purpose) {
    const day = this.deps.now().toISOString().slice(0, 10);
    for (const c of calls) {
      await q(
        `INSERT INTO api_requests (at, utc_day, endpoint, purpose, http_status, ok, day_limit, day_remaining, minute_limit, minute_remaining, error)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)`,
        [this.deps.now(), day, c.endpoint, purpose, c.httpStatus, c.ok, c.dayLimit, c.dayRemaining, c.minuteLimit, c.minuteRemaining, c.error ?? null],
        this.db,
      );
      // Use the limits the supplier actually reports.
      if (c.dayLimit) this.dayLimit = c.dayLimit;
      if (c.minuteLimit) this.minuteLimit = c.minuteLimit;
    }
    for (const c of calls) {
      if (c.blocked) {
        await setSetting("poller_blocked", { at: this.deps.now(), error: c.error ?? "blocked" }, this.db);
        await raiseAlert("blocked", "critical", `The football data supplier refused our requests (${c.error ?? "blocked"}). The poller has stopped trying. Contact API-Football support, then press Resume on Admin > Health.`, this.db);
        this.log(`BLOCKED: ${c.error}`);
      } else if (c.rateLimited) {
        this.limitReplies++;
        this.waitUntil = this.deps.now().getTime() + backoffMs(this.limitReplies);
        this.log(`Rate limited; waiting ${backoffMs(this.limitReplies) / 1000}s`);
        if (this.limitReplies >= 3) await raiseAlert("rate-limited", "warning", "The data supplier keeps saying we are sending requests too fast. The poller is backing off.", this.db);
      } else if (c.dayExhausted) {
        await raiseAlert("day-exhausted", "critical", "Today's request allowance is used up. Live points will resume after midnight UTC.", this.db);
      } else if (c.ok) {
        this.limitReplies = 0;
        await resolveAlert("rate-limited", this.db);
      }
    }
  }

  private async blocked(): Promise<boolean> {
    return (await getSetting("poller_blocked", this.db)) !== null;
  }

  /** One pass of the loop. Returns what it did (for logs and tests). */
  async tick(): Promise<string[]> {
    const did: string[] = [];
    const now = this.deps.now();
    await setSetting("poller_heartbeat", now, this.db);
    const locked = await lockDueWeeks(now, this.db);
    if (locked.length) did.push(`locked week ${locked.join(",")}`);
    for (const w of locked) await rescoreWeek(w, this.db);

    if ((await getSetting<boolean>("poller_paused", this.db)) === true) return [...did, "paused"];
    if (await this.blocked()) return [...did, "blocked"];
    if (now.getTime() < this.waitUntil) return [...did, "backing off"];

    const p = await this.pacing();
    await setSetting("poller_mode", p.mode, this.db);
    if (p.mode === "stopped") {
      await raiseAlert("budget-95", "critical", "95% of today's requests are used: live points are paused until midnight UTC (corrections continue).", this.db);
    } else if (p.mode !== "normal") {
      await raiseAlert(`budget-${p.mode}`, "warning", `Daily request use is high: live fetching slowed to every ${p.liveIntervalSec / 60} minutes.`, this.db);
    }

    if (await this.dailyJobsDue(now)) did.push(...(await this.dailyJobs(now)));
    if ((await getSetting<boolean>("job_refresh_stats", this.db)) === true) {
      // Requested from Admin > Players: season numbers for suggested prices (several calls per club).
      await setSetting("job_refresh_stats", false, this.db);
      const cat = await syncCatalogue(this.deps.provider, this.db, { withStats: true });
      await this.record(cat.calls, "background");
      if (cat.ok) {
        await refreshSuggestions(this.db);
        did.push("season numbers + price suggestions");
      }
    }

    if (p.mode !== "stopped" && now.getTime() - this.lastLiveAt >= p.liveIntervalSec * 1000) {
      const live = await this.liveFixtures(now);
      if (live.length) {
        this.lastLiveAt = now.getTime();
        did.push(await this.fetch(live, "live"));
      }
    }
    if (p.correctionsAllowed) {
      const due = await this.recheckDue(now);
      if (due.length) did.push(await this.fetch(due.map((d) => d.provider_id), "correction", due));
    }
    await this.finaliseDue(now);
    await this.checkStale(now);
    return did;
  }

  private async dailyJobsDue(now: Date) {
    const last = await getSetting<string>("poller_daily_done", this.db);
    return last !== now.toISOString().slice(0, 10);
  }

  /** Fixture list (1 call), account status (1 call), squads (one call per club). */
  async dailyJobs(now: Date): Promise<string[]> {
    const did: string[] = [];
    const fx = await syncFixtures(this.deps.provider, now, this.db);
    await this.record(fx.calls, "background");
    if (!fx.ok) return [`fixture list failed: ${fx.error}`];
    did.push("fixture list");
    const st = await this.deps.provider.getAccountStatus();
    await this.record(st.calls, "background");
    if (st.ok) {
      await setSetting("api_status", { ...st.data, checkedAt: now }, this.db);
      await this.checkExpiry(now, st.data.expires);
      did.push("account status");
    }
    const cat = await syncCatalogue(this.deps.provider, this.db);
    await this.record(cat.calls, "background");
    if (cat.ok) did.push("squads");
    const newPlayers = await one<{ n: string }>("SELECT count(*) AS n FROM players WHERE NOT approved", [], this.db);
    if (Number(newPlayers?.n ?? 0) > 0) await raiseAlert("new-players", "info", `${newPlayers!.n} new player(s) are waiting for approval in Admin > Players.`, this.db);
    await setSetting("poller_daily_done", now.toISOString().slice(0, 10), this.db);
    return did;
  }

  /** Warns seven days before the paid plan ends (uses the date Ben typed if the supplier gives none). */
  async checkExpiry(now: Date, fromSupplier: Date | null) {
    const typed = await getSetting<string>("api_expiry_manual", this.db);
    const expires = fromSupplier ?? (typed ? new Date(typed) : null);
    if (!expires) return;
    const days = (expires.getTime() - now.getTime()) / 86400_000;
    if (days <= 7) await raiseAlert("expiry", "warning", `The API-Football plan ends ${expires.toDateString()} (${Math.max(0, Math.ceil(days))} days). Renew it to keep live points running.`, this.db);
    else await resolveAlert("expiry", this.db);
  }

  /** Matches that are live now, or kicked off within the last 180 minutes and have not finished. */
  async liveFixtures(now: Date): Promise<string[]> {
    const rows = await q<{ provider_id: string; status: string; kickoff: Date }>(
      `SELECT provider_id, status, kickoff FROM fixtures
        WHERE week_number IS NOT NULL AND kickoff <= $1 AND kickoff >= $1::timestamptz - make_interval(mins => $2)
           OR status = ANY($3::text[])`,
      [now, MATCH_WINDOW_MIN, [...LIVE]],
      this.db,
    );
    return rows.filter((r) => !FINISHED.has(r.status) && !["PST", "CANC", "ABD", "AWD", "WO"].includes(r.status)).map((r) => r.provider_id);
  }

  /** Finished matches due a recheck at 30 minutes, 24 hours or 72 hours after full time. */
  async recheckDue(now: Date): Promise<{ id: number; provider_id: string; stage: number }[]> {
    const rows = await q<{ id: number; provider_id: string; finished_at: Date; recheck_stage: number }>(
      "SELECT id, provider_id, finished_at, recheck_stage FROM fixtures WHERE finished_at IS NOT NULL AND recheck_stage < 3 AND week_number IS NOT NULL ORDER BY finished_at LIMIT 20",
      [],
      this.db,
    );
    const due: { id: number; provider_id: string; stage: number }[] = [];
    for (const r of rows) {
      let stage = r.recheck_stage;
      while (stage < 3 && now.getTime() - r.finished_at.getTime() >= RECHECKS_MIN[stage] * 60_000) stage++;
      if (stage > r.recheck_stage) due.push({ id: r.id, provider_id: r.provider_id, stage });
    }
    return due;
  }

  private async fetch(ids: string[], purpose: Purpose, rechecks: { id: number; stage: number }[] = []): Promise<string> {
    const res = await this.deps.provider.getFixtureDetails(ids);
    await this.record(res.calls, purpose);
    if (!res.ok) return `${purpose} fetch failed: ${res.error}`;
    const now = this.deps.now();
    await setSetting("last_success", now, this.db);
    await resolveAlert("stale", this.db);
    const weeks = new Set<number>();
    let corrections = 0;
    for (const d of res.data) {
      const stored = await storeDetail(d, this.db);
      if (!stored) continue;
      corrections += stored.corrections;
      const week = await rescoreFixture(stored.fixtureId, now, this.db);
      if (week !== null) weeks.add(week);
    }
    for (const r of rechecks) await q("UPDATE fixtures SET recheck_stage = $2 WHERE id = $1", [r.id, r.stage], this.db);
    for (const w of weeks) await rescoreWeek(w, this.db);
    if (corrections) await raiseAlert("corrections", "info", `${corrections} change(s) to final points are waiting for approval in Admin > Corrections.`, this.db);
    return `${purpose}: ${res.data.length} match(es)`;
  }

  /** Warn if there are live matches but no successful fetch for three minutes. */
  private async checkStale(now: Date) {
    const live = await this.liveFixtures(now);
    if (!live.length) return;
    const last = await getSetting<string>("last_success", this.db);
    if (!last || now.getTime() - new Date(last).getTime() > STALE_WARNING_MS) {
      await raiseAlert("stale", "warning", "No successful live update for over three minutes.", this.db);
    }
  }

  /** Recomputes points for matches whose final-status clock has run out (no fetch needed). */
  async finaliseDue(now: Date) {
    const rows = await q<{ id: number }>(
      "SELECT f.id FROM fixtures f WHERE f.data_complete AND f.finished_at <= $1::timestamptz - interval '72 hours' AND EXISTS (SELECT 1 FROM player_points p WHERE p.fixture_id = f.id AND p.status <> 'final')",
      [now],
      this.db,
    );
    const weeks = new Set<number>();
    for (const r of rows) {
      const w = await rescoreFixture(r.id, now, this.db);
      if (w !== null) weeks.add(w);
    }
    for (const w of weeks) await rescoreWeek(w, this.db);
  }
}

/** Only one poller may run at a time: a database lock held for the life of the process. */
export const POLLER_LOCK_ID = 7_042_026;
