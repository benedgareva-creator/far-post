// The poller: the one server program that talks to the football data supplier for everyone.
// It fetches live matches every 60 seconds (slower when the daily budget runs low),
// rechecks finished matches after 30 minutes, 24 hours and 72 hours, keeps the fixture
// list and squads fresh once a day, and raises alerts for Ben.
import { getSetting, one, q, setSetting, type Db, pool } from "../lib/db";
import { FINISHED, LIVE } from "../lib/game/weeks";
import { RequestRefused, type CallMeta, type FootballProvider } from "../lib/provider/types";
import { raiseAlert, resolveAlert, retryAlertEmails } from "../lib/services/alerts";
import { emailUsage } from "../lib/email";
import { config } from "../lib/config";
import { rescoreFixture, rescoreWeek } from "../lib/services/scoring";
import { freezeDueWeeks, storeDetail, syncCatalogue, syncFixtures } from "../lib/services/sync";
import { lockDueWeeks } from "../lib/services/teams";
import { refreshSuggestions } from "../lib/services/admin";
import { backoffMs, pacing, type Pacing } from "./budget";

export const MATCH_WINDOW_MIN = 180; // allow 180 minutes per match
// Rechecks after full time: 30 minutes, 24 hours, 72 hours (points become final), and one later
// look at 7 days to catch late corrections. Ben can also ask for any match to be fetched again.
export const RECHECKS_MIN = [30, 24 * 60, 72 * 60, 7 * 24 * 60];
export const LAST_STAGE = RECHECKS_MIN.length;
/** A match still missing data after 72 hours is retried every 6 hours, for up to 14 days. */
export const INCOMPLETE_RETRY_MS = 6 * 3600_000;
export const INCOMPLETE_GIVE_UP_MS = 14 * 24 * 3600_000;
/** A match we asked for that the supplier left out of its reply is asked for again after 15 minutes. */
export const MISSING_RETRY_MS = 15 * 60_000;
/** Background jobs (squads, season numbers) stop at 90% of the day, keeping the rest for live points and corrections. */
export const BACKGROUND_SHARE = 0.9;
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
  /** What the requests being made right now are for (decides which budget rules apply). */
  private purpose: Purpose = "background";
  /** Set when the supplier blocks us, the day runs out or we are told to slow down: no more requests this pass. */
  private halted: string | null = null;

  constructor(private deps: PollerDeps) {
    this.db = deps.db ?? pool();
    this.log = deps.log ?? ((m) => console.log(`[poller ${new Date().toISOString()}] ${m}`));
    this.sleep = deps.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms)));
    this.dayLimit = deps.limits.day;
    this.minuteLimit = deps.limits.minute;
    deps.provider.throttle = () => this.gate();
    deps.provider.onCall = (m) => this.recordOne(m);
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

  /**
   * Runs before every single request. Refuses it if the poller has been halted this pass, the
   * supplier has blocked us, today's allowance is used up, or the request would eat into the share
   * kept for live points and corrections. Otherwise waits for the minimum gap between calls.
   */
  private async gate() {
    if (this.halted) throw new RequestRefused(this.halted);
    if (await this.blocked()) throw new RequestRefused("blocked");
    if (await this.dayStopped()) throw new RequestRefused("day allowance used up");
    const used = await this.usedToday();
    const p = pacing({ dayLimit: this.dayLimit, minuteLimit: this.minuteLimit, usedToday: used });
    if (used >= this.dayLimit) throw new RequestRefused("day allowance used up");
    if (this.purpose === "live" && p.mode === "stopped") throw new RequestRefused("live budget used");
    if (this.purpose === "background" && used >= this.dayLimit * BACKGROUND_SHARE) throw new RequestRefused("background budget used");
    const wait = Math.max(this.lastCallAt + p.minGapMs - this.deps.now().getTime(), this.waitUntil - this.deps.now().getTime(), 0);
    if (wait > 0) await this.sleep(wait);
    this.lastCallAt = this.deps.now().getTime();
  }

  /** Counts one request the moment it returns, and reacts to what the supplier said. */
  private async recordOne(c: CallMeta) {
    const now = this.deps.now();
    const day = now.toISOString().slice(0, 10);
    await q(
      `INSERT INTO api_requests (at, utc_day, endpoint, purpose, http_status, ok, day_limit, day_remaining, minute_limit, minute_remaining, error)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)`,
      [now, day, c.endpoint, this.purpose, c.httpStatus, c.ok, c.dayLimit, c.dayRemaining, c.minuteLimit, c.minuteRemaining, c.error ?? null],
      this.db,
    );
    // Use the limits the supplier actually reports.
    if (c.dayLimit) this.dayLimit = c.dayLimit;
    if (c.minuteLimit) this.minuteLimit = c.minuteLimit;
    if (c.blocked) {
      this.halted = "blocked";
      await setSetting("poller_blocked", { at: now, error: c.error ?? "blocked" }, this.db);
      await raiseAlert("blocked", "critical", `The football data supplier refused our requests (${c.error ?? "blocked"}). The poller has stopped trying. Contact API-Football support, then press Resume on Admin > Health.`, this.db);
      this.log(`BLOCKED: ${c.error}`);
    } else if (c.rateLimited) {
      this.halted = "rate limited";
      this.limitReplies++;
      this.waitUntil = now.getTime() + backoffMs(this.limitReplies);
      this.log(`Rate limited; waiting ${backoffMs(this.limitReplies) / 1000}s`);
      if (this.limitReplies >= 3) await raiseAlert("rate-limited", "warning", "The data supplier keeps saying we are sending requests too fast. The poller is backing off.", this.db);
    } else if (c.dayExhausted) {
      // Stop every kind of request until midnight UTC, whatever the reply's headers said.
      this.halted = "day allowance used up";
      await setSetting("poller_day_stop", day, this.db);
      await raiseAlert("day-exhausted", "critical", "Today's request allowance is used up. Live points will resume after midnight UTC.", this.db);
    } else if (c.ok) {
      this.limitReplies = 0;
      await resolveAlert("rate-limited", this.db);
    }
  }

  private async dayStopped(): Promise<boolean> {
    const stop = await getSetting<string>("poller_day_stop", this.db);
    return stop === this.deps.now().toISOString().slice(0, 10);
  }

  /** Runs one supplier job with a purpose. A refused request ends the job quietly; returns null then. */
  private async job<T>(purpose: Purpose, fn: () => Promise<T>): Promise<T | null> {
    this.purpose = purpose;
    try {
      return await fn();
    } catch (e) {
      if (e instanceof RequestRefused) return null;
      throw e;
    } finally {
      this.purpose = "background";
    }
  }

  private async blocked(): Promise<boolean> {
    return (await getSetting("poller_blocked", this.db)) !== null;
  }

  /** One pass of the loop. Returns what it did (for logs and tests). */
  async tick(): Promise<string[]> {
    const did: string[] = [];
    const now = this.deps.now();
    this.halted = null;
    await setSetting("poller_heartbeat", now, this.db);
    await freezeDueWeeks(now, this.db);
    const locked = await lockDueWeeks(now, this.db);
    if (locked.length) did.push(`locked week ${locked.join(",")}`);
    for (const w of locked) await rescoreWeek(w, this.db);
    await this.finaliseDue(now);
    await this.checkEmail();

    if ((await getSetting<boolean>("poller_paused", this.db)) === true) return [...did, "paused"];
    if (await this.blocked()) return [...did, "blocked"];
    if (await this.dayStopped()) return [...did, "day allowance used up"];
    if ((await getSetting<string>("poller_day_stop", this.db)) !== null) {
      // A new UTC day: lift yesterday's stop.
      await setSetting("poller_day_stop", null, this.db);
      await resolveAlert("day-exhausted", this.db);
    }
    if (now.getTime() < this.waitUntil) return [...did, "backing off"];

    const p = await this.pacing();
    await setSetting("poller_mode", p.mode, this.db);
    if (p.mode === "stopped") {
      await raiseAlert("budget-95", "critical", "95% of today's requests are used: live points are paused until midnight UTC (corrections continue).", this.db);
    } else if (p.mode !== "normal") {
      await raiseAlert(`budget-${p.mode}`, "warning", `Daily request use is high: live fetching slowed to every ${p.liveIntervalSec / 60} minutes.`, this.db);
    }

    // Once a day: squads, then the fixture list (fresh statuses before live fetching), then account status.
    if (await this.dailyJobsDue(now)) {
      const r = await this.job("background", () => this.dailyJobs(now));
      if (r) did.push(...r);
    }
    if (this.halted) return [...did, `stopped: ${this.halted}`];
    // Every request below is checked against the budget as it is made.
    if (p.mode !== "stopped" && now.getTime() - this.lastLiveAt >= p.liveIntervalSec * 1000) {
      const live = await this.liveFixtures(now);
      if (live.length) {
        this.lastLiveAt = now.getTime();
        const r = await this.job("live", () => this.fetch(live, "live"));
        if (r) did.push(r);
      }
    }
    if (this.halted) return [...did, `stopped: ${this.halted}`];
    if ((await this.pacing()).correctionsAllowed) {
      const due = await this.recheckDue(now);
      if (due.length) {
        const r = await this.job("correction", () => this.fetch(due.map((d) => d.provider_id), "correction", due));
        if (r) did.push(r);
      }
    }
    if (this.halted) return [...did, `stopped: ${this.halted}`];
    if ((await getSetting<boolean>("job_refresh_fixtures", this.db)) === true) {
      // Requested from Admin > Weeks after choosing the launch round.
      const fx = await this.job("background", () => syncFixtures(this.deps.provider, now, this.db));
      if (fx?.ok) {
        await setSetting("job_refresh_fixtures", false, this.db);
        did.push("fixture list (launch round)");
      }
    }
    if ((await getSetting<boolean>("job_refresh_stats", this.db)) === true) {
      // Requested from Admin > Players: season numbers for suggested prices (several calls per club).
      const cat = await this.job("background", () => syncCatalogue(this.deps.provider, this.db, { withStats: true }));
      if (cat?.ok) {
        await setSetting("job_refresh_stats", false, this.db);
        await refreshSuggestions(this.db);
        did.push("season numbers + price suggestions");
      }
    }
    await this.checkStale(now);
    if (this.halted) did.push(`stopped: ${this.halted}`);
    return did;
  }

  /** Retries failed alert emails and warns when the email allowance is nearly used. */
  private async checkEmail() {
    await retryAlertEmails(this.db);
    const u = await emailUsage(this.db);
    if (u.today >= 0.8 * config.emailDayLimit || u.month >= 0.8 * config.emailMonthLimit) {
      await raiseAlert("email-budget", "warning", `Email use is high: ${u.today}/${config.emailDayLimit} today, ${u.month}/${config.emailMonthLimit} this month. Sign-in links stop just before the limit so alerts still get through.`, this.db);
    } else {
      await resolveAlert("email-budget", this.db);
    }
  }

  private async dailyJobsDue(now: Date) {
    const last = await getSetting<string>("poller_daily_done", this.db);
    return last !== now.toISOString().slice(0, 10);
  }

  /**
   * Clubs and squads first (one call per club), so a fresh database knows every club before the
   * fixture list (1 call) arrives; then account status (1 call). Only marked done when both succeed.
   */
  async dailyJobs(now: Date): Promise<string[]> {
    const did: string[] = [];
    const cat = await syncCatalogue(this.deps.provider, this.db);
    if (!cat.ok) return [`squads failed: ${cat.error}`];
    did.push("squads");
    const fx = await syncFixtures(this.deps.provider, now, this.db);
    if (!fx.ok) return [...did, `fixture list failed: ${fx.error}`];
    did.push("fixture list");
    const st = await this.deps.provider.getAccountStatus();
    if (st.ok) {
      await setSetting("api_status", { ...st.data, checkedAt: now }, this.db);
      await this.checkExpiry(now, st.data.expires);
      did.push("account status");
    }
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

  /**
   * Finished matches to fetch again: scheduled rechecks (30m, 24h, 72h, 7d after full time), matches
   * Ben asked for, and matches still missing data after 72 hours (every 6 hours for up to 14 days).
   */
  async recheckDue(now: Date): Promise<{ id: number; provider_id: string; stage: number }[]> {
    const rows = await q<{ id: number; provider_id: string; finished_at: Date; recheck_stage: number; data_complete: boolean; refetch_requested: boolean }>(
      `SELECT id, provider_id, finished_at, recheck_stage, data_complete, refetch_requested FROM fixtures
        WHERE finished_at IS NOT NULL AND week_number IS NOT NULL AND (retry_after IS NULL OR retry_after <= $1)
          AND (refetch_requested OR recheck_stage < $2 OR (NOT data_complete AND finished_at > $1::timestamptz - make_interval(secs => $3)))
        ORDER BY refetch_requested DESC, finished_at LIMIT 20`,
      [now, LAST_STAGE, INCOMPLETE_GIVE_UP_MS / 1000],
      this.db,
    );
    const due: { id: number; provider_id: string; stage: number }[] = [];
    for (const r of rows) {
      let stage = r.recheck_stage;
      while (stage < LAST_STAGE && now.getTime() - r.finished_at.getTime() >= RECHECKS_MIN[stage] * 60_000) stage++;
      const retryIncomplete = !r.data_complete && r.recheck_stage >= 3;
      if (stage > r.recheck_stage || r.refetch_requested || retryIncomplete) due.push({ id: r.id, provider_id: r.provider_id, stage });
    }
    return due;
  }

  private async fetch(ids: string[], purpose: Purpose, rechecks: { id: number; stage: number }[] = []): Promise<string> {
    const res = await this.deps.provider.getFixtureDetails(ids);
    if (!res.ok) return `${purpose} fetch failed: ${res.error}`;
    const now = this.deps.now();
    await setSetting("last_success", now, this.db);
    await resolveAlert("stale", this.db);
    const weeks = new Set<number>();
    const returned = new Set<number>();
    let corrections = 0;
    for (const d of res.data) {
      const stored = await storeDetail(d, this.db);
      if (!stored) continue;
      returned.add(stored.fixtureId);
      corrections += stored.corrections;
      const week = await rescoreFixture(stored.fixtureId, now, this.db);
      if (week !== null) weeks.add(week);
    }
    // A recheck only counts as done for matches that actually came back. Matches the supplier left
    // out are asked for again shortly; matches still incomplete after 72 hours keep being retried.
    for (const r of rechecks) {
      if (!returned.has(r.id)) {
        await q("UPDATE fixtures SET retry_after = $2 WHERE id = $1", [r.id, new Date(now.getTime() + MISSING_RETRY_MS)], this.db);
        continue;
      }
      const f = await one<{ data_complete: boolean; label: string }>(
        `SELECT f.data_complete, hc.short_name || ' v ' || ac.short_name AS label
           FROM fixtures f JOIN clubs hc ON hc.id = f.home_club_id JOIN clubs ac ON ac.id = f.away_club_id WHERE f.id = $1`,
        [r.id],
        this.db,
      );
      const incomplete = !f?.data_complete && r.stage >= 3;
      await q(
        "UPDATE fixtures SET recheck_stage = GREATEST(recheck_stage, $2), refetch_requested = false, retry_after = $3 WHERE id = $1",
        [r.id, r.stage, incomplete ? new Date(now.getTime() + INCOMPLETE_RETRY_MS) : null],
        this.db,
      );
      if (incomplete) {
        await raiseAlert(`incomplete-${r.id}`, "warning", `${f?.label ?? "A match"} is still missing some numbers 72 hours after full time, so its points cannot become final. Far Post retries every 6 hours for 14 days; you can also press "Fetch again" on Admin > Corrections.`, this.db);
      } else {
        await resolveAlert(`incomplete-${r.id}`, this.db);
      }
    }
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
