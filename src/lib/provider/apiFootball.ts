// Real data from API-Football v3 (https://www.api-football.com/documentation_v3).
// Bought directly from api-football.com (not RapidAPI), so requests use the
// x-apisports-key header. Field meanings marked TO VERIFY must be checked against
// real responses during the Free-plan capture (spec section 9).
import type { Position } from "../game/rules";
import type {
  AccountStatus,
  CallMeta,
  FixtureDetail,
  FootballProvider,
  ProviderClub,
  ProviderFixture,
  ProviderPlayer,
  ProviderPlayerLine,
  ProviderResult,
} from "./types";

export interface ApiFootballOptions {
  key: string;
  baseUrl: string;
  leagueId: string;
  season: string;
  batch: boolean;
  fetchImpl?: typeof fetch;
}

const POSITION: Record<string, Position> = { Goalkeeper: "GK", Defender: "DEF", Midfielder: "MID", Attacker: "FWD", G: "GK", D: "DEF", M: "MID", F: "FWD" };
const FINISHED = new Set(["FT", "AET", "PEN"]);

type Json = Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any

const num = (v: unknown): number | null => (typeof v === "number" && Number.isFinite(v) ? v : typeof v === "string" && v.trim() !== "" && !isNaN(Number(v)) ? Number(v) : null);
const header = (h: Headers, name: string) => num(h.get(name));

export class ApiFootballProvider implements FootballProvider {
  readonly name = "api-football";
  readonly batchSize: number;
  throttle?: () => Promise<void>;
  onCall?: (meta: CallMeta) => Promise<void>;
  private fetchImpl: typeof fetch;

  constructor(private opts: ApiFootballOptions) {
    this.batchSize = opts.batch ? 20 : 1;
    this.fetchImpl = opts.fetchImpl ?? fetch;
  }

  callsForLiveFetch(n: number): number {
    return this.opts.batch ? Math.ceil(n / 20) : 2 * n;
  }

  private async call(path: string, params: Record<string, string>): Promise<{ meta: CallMeta; body: Json | null }> {
    const out = await this.send(path, params);
    if (this.onCall) await this.onCall(out.meta);
    return out;
  }

  private async send(path: string, params: Record<string, string>): Promise<{ meta: CallMeta; body: Json | null }> {
    const url = new URL(path, this.opts.baseUrl.endsWith("/") ? this.opts.baseUrl : this.opts.baseUrl + "/");
    for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v);
    const endpoint = `${path}?${new URLSearchParams(params).toString()}`;
    if (this.throttle) await this.throttle();
    let res: Response;
    try {
      res = await this.fetchImpl(url, { headers: { "x-apisports-key": this.opts.key }, signal: AbortSignal.timeout(20_000) });
    } catch (e) {
      return { meta: { endpoint, httpStatus: null, ok: false, dayLimit: null, dayRemaining: null, minuteLimit: null, minuteRemaining: null, error: `Network error: ${(e as Error).message}` }, body: null };
    }
    const meta: CallMeta = {
      endpoint,
      httpStatus: res.status,
      ok: res.ok,
      dayLimit: header(res.headers, "x-ratelimit-requests-limit"),
      dayRemaining: header(res.headers, "x-ratelimit-requests-remaining"),
      minuteLimit: header(res.headers, "x-ratelimit-limit"),
      minuteRemaining: header(res.headers, "x-ratelimit-remaining"),
    };
    let body: Json | null = null;
    try {
      body = (await res.json()) as Json;
    } catch {
      meta.ok = false;
      meta.error = `Unreadable reply (HTTP ${res.status})`;
    }
    if (res.status === 429) meta.rateLimited = true;
    if ([401, 403, 499].includes(res.status)) meta.blocked = true;
    // API-Football often answers HTTP 200 with an "errors" object instead.
    const errors = body?.errors;
    const errorText = errors && (Array.isArray(errors) ? errors.join("; ") : Object.entries(errors).map(([k, v]) => `${k}: ${v}`).join("; "));
    if (errorText) {
      meta.ok = false;
      meta.error = errorText;
      const keys = Array.isArray(errors) ? [] : Object.keys(errors);
      if (keys.includes("rateLimit")) meta.rateLimited = true;
      else if (keys.includes("requests")) meta.dayExhausted = true;
      else if (keys.some((k) => ["token", "access", "suspended", "ip"].includes(k))) meta.blocked = true;
    }
    if (!res.ok && !meta.error) meta.error = `HTTP ${res.status}`;
    return { meta, body };
  }

  private fail<T>(calls: CallMeta[]): ProviderResult<T> {
    return { ok: false, error: calls.find((c) => !c.ok)?.error ?? "Request failed", calls };
  }

  async getClubs(): Promise<ProviderResult<ProviderClub[]>> {
    const { meta, body } = await this.call("teams", { league: this.opts.leagueId, season: this.opts.season });
    if (!meta.ok || !body) return this.fail([meta]);
    const data = (body.response as Json[]).map((r) => ({
      providerId: String(r.team.id),
      name: String(r.team.name),
      shortName: String(r.team.code ?? r.team.name.slice(0, 3)).toUpperCase(),
    }));
    return { ok: true, data, calls: [meta] };
  }

  /** Players with this season's league totals (for suggested prices). Paged: about two calls per club. */
  async getPlayers(clubProviderId: string): Promise<ProviderResult<ProviderPlayer[]>> {
    const calls: CallMeta[] = [];
    const out: ProviderPlayer[] = [];
    for (let page = 1; page <= 5; page++) {
      const { meta, body } = await this.call("players", { team: clubProviderId, season: this.opts.season, page: String(page) });
      calls.push(meta);
      if (!meta.ok || !body) return this.fail(calls);
      for (const r of body.response as Json[]) {
        const stats = (r.statistics as Json[]).find((s) => String(s.league?.id) === this.opts.leagueId) ?? null;
        const pos = POSITION[stats?.games?.position ?? ""];
        if (!pos) continue;
        out.push({
          providerId: String(r.player.id),
          clubProviderId,
          name: String(r.player.name),
          position: pos,
          seasonGoals: stats ? num(stats.goals?.total) ?? 0 : null,
          seasonAssists: stats ? num(stats.goals?.assists) ?? 0 : null,
          seasonMinutes: stats ? num(stats.games?.minutes) ?? 0 : null,
        });
      }
      if (!body.paging || body.paging.current >= body.paging.total) break;
    }
    return { ok: true, data: out, calls };
  }

  async getSquad(clubProviderId: string): Promise<ProviderResult<ProviderPlayer[]>> {
    const { meta, body } = await this.call("players/squads", { team: clubProviderId });
    if (!meta.ok || !body) return this.fail([meta]);
    const out: ProviderPlayer[] = [];
    for (const r of body.response as Json[]) {
      for (const p of (r.players ?? []) as Json[]) {
        const pos = POSITION[p.position ?? ""];
        if (!pos) continue;
        out.push({ providerId: String(p.id), clubProviderId, name: String(p.name), position: pos, seasonGoals: null, seasonAssists: null, seasonMinutes: null });
      }
    }
    return { ok: true, data: out, calls: [meta] };
  }

  async getFixtures(): Promise<ProviderResult<ProviderFixture[]>> {
    const { meta, body } = await this.call("fixtures", { league: this.opts.leagueId, season: this.opts.season });
    if (!meta.ok || !body) return this.fail([meta]);
    return { ok: true, data: (body.response as Json[]).map(parseFixture), calls: [meta] };
  }

  async getFixtureDetails(ids: string[]): Promise<ProviderResult<FixtureDetail[]>> {
    if (ids.length === 0) return { ok: true, data: [], calls: [] };
    const calls: CallMeta[] = [];
    const out: FixtureDetail[] = [];
    if (this.opts.batch) {
      // Normal mode: one call returns up to 20 matches with events and player statistics.
      for (let i = 0; i < ids.length; i += 20) {
        const { meta, body } = await this.call("fixtures", { ids: ids.slice(i, i + 20).join("-") });
        calls.push(meta);
        if (!meta.ok || !body) return this.fail(calls);
        for (const r of body.response as Json[]) out.push(parseDetail(r, r.players ?? null));
      }
    } else {
      // Fallback: two calls per match (fixture + its player statistics).
      for (const id of ids) {
        const f = await this.call("fixtures", { id });
        calls.push(f.meta);
        if (!f.meta.ok || !f.body) return this.fail(calls);
        const p = await this.call("fixtures/players", { fixture: id });
        calls.push(p.meta);
        if (!p.meta.ok || !p.body) return this.fail(calls);
        const r = (f.body.response as Json[])[0];
        if (r) out.push(parseDetail(r, p.body.response ?? null));
      }
    }
    return { ok: true, data: out, calls };
  }

  async getAccountStatus(): Promise<ProviderResult<AccountStatus>> {
    const { meta, body } = await this.call("status", {});
    if (!meta.ok || !body) return this.fail([meta]);
    const r = body.response ?? {};
    const end = r.subscription?.end ? new Date(r.subscription.end) : null;
    return {
      ok: true,
      calls: [meta],
      data: {
        plan: r.subscription?.plan ?? null,
        expires: end && !isNaN(end.getTime()) ? end : null,
        active: typeof r.subscription?.active === "boolean" ? r.subscription.active : null,
        requestsToday: num(r.requests?.current),
        dayLimit: num(r.requests?.limit_day),
      },
    };
  }
}

function parseFixture(r: Json): ProviderFixture {
  const round = String(r.league?.round ?? "");
  const m = round.match(/(\d+)\s*$/);
  return {
    providerId: String(r.fixture.id),
    round,
    roundNumber: m ? Number(m[1]) : null,
    homeClubProviderId: String(r.teams.home.id),
    awayClubProviderId: String(r.teams.away.id),
    kickoff: new Date(r.fixture.date),
    status: String(r.fixture.status?.short ?? "NS"),
    minute: num(r.fixture.status?.elapsed),
    homeGoals: num(r.goals?.home),
    awayGoals: num(r.goals?.away),
  };
}

/**
 * Turns the supplier's per-player statistics into our numbers.
 * Blank handling (TO VERIFY against real data, spec section 3):
 *  - a listed player with blank minutes in a finished match did not play: minutes 0;
 *  - during a live match blank minutes stay unknown (pending);
 *  - once minutes are known, blank counters (goals, saves, cards...) mean zero;
 *  - own goals come only from the match events, never from goals.total.
 */
function parseDetail(r: Json, playersBlock: Json[] | null): FixtureDetail {
  const fixture = parseFixture(r);
  if (!playersBlock || playersBlock.length === 0) return { fixture, players: null };
  const finished = FINISHED.has(fixture.status);
  const ownGoals = new Map<string, number>();
  for (const e of (r.events ?? []) as Json[]) {
    if (e.type === "Goal" && /own goal/i.test(String(e.detail)) && e.player?.id != null) {
      const id = String(e.player.id);
      ownGoals.set(id, (ownGoals.get(id) ?? 0) + 1);
    }
  }
  const eventsKnown = Array.isArray(r.events);
  const lines: ProviderPlayerLine[] = [];
  for (const team of playersBlock) {
    for (const p of (team.players ?? []) as Json[]) {
      const s = (p.statistics ?? [])[0] ?? {};
      let minutes = num(s.games?.minutes);
      if (minutes === null && finished) minutes = 0;
      const known = minutes !== null;
      const zeroIfKnown = (v: unknown) => num(v) ?? (known ? 0 : null);
      const id = String(p.player.id);
      lines.push({
        playerProviderId: id,
        playerName: String(p.player.name),
        position: POSITION[s.games?.position ?? ""] ?? null,
        clubProviderId: String(team.team.id),
        minutes,
        goals: zeroIfKnown(s.goals?.total),
        assists: zeroIfKnown(s.goals?.assists),
        saves: zeroIfKnown(s.goals?.saves),
        yellow: zeroIfKnown(s.cards?.yellow),
        red: zeroIfKnown(s.cards?.red),
        ownGoals: eventsKnown ? ownGoals.get(id) ?? 0 : null,
        penSaved: zeroIfKnown(s.penalty?.saved),
        penMissed: zeroIfKnown(s.penalty?.missed),
      });
    }
  }
  return { fixture, players: lines };
}
