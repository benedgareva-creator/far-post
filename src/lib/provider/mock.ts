// A made-up demo league so the whole game works before any subscription.
// Clubs and players are invented. Matches play out in real time from the
// anchor date: events are generated deterministically from each match's id,
// so every restart sees the same season.
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

const CLUBS: [string, string][] = [
  ["Ashford Vale", "ASV"], ["Bramwell United", "BRU"], ["Calder Athletic", "CAL"], ["Dunmore Rovers", "DUN"],
  ["Elmstead Town", "ELM"], ["Fairhaven City", "FAI"], ["Glenmoor Albion", "GLE"], ["Harrowgate FC", "HAR"],
  ["Ironbridge Wanderers", "IRO"], ["Kestrel Park", "KES"], ["Langford Borough", "LAN"], ["Marston Forge", "MAR"],
  ["Northcliff Rangers", "NOR"], ["Oakhurst County", "OAK"], ["Penhallow Athletic", "PEN"], ["Queensbury Harbour", "QUE"],
  ["Redwater United", "RED"], ["Saltmarsh Town", "SAL"], ["Thornbury Villa", "THO"], ["Westbrook Sporting", "WES"],
];
const FIRST = ["Alex", "Ben", "Callum", "Dani", "Eli", "Femi", "Gus", "Hari", "Isak", "Jonah", "Kai", "Leo", "Milo", "Nico", "Owen", "Pavel", "Quinn", "Rafa", "Sami", "Theo", "Uri", "Vik", "Wes", "Yusuf", "Zane", "Arlo", "Bo", "Cian", "Dev", "Ezra"];
const LAST = ["Ashby", "Brennan", "Castell", "Doyle", "Ekwueme", "Farrow", "Galloway", "Hollis", "Ibarra", "Jessop", "Kowal", "Lindqvist", "Mbeki", "Navarro", "Okafor", "Pryce", "Quayle", "Rourke", "Sandoval", "Tierney", "Underhill", "Vance", "Whitlock", "Yardley", "Zielinski", "Abara", "Bellamy", "Crowe", "Delacroix", "Esposito", "Fenwick", "Grieve"];
const SHAPE: Position[] = ["GK", "GK", "DEF", "DEF", "DEF", "DEF", "DEF", "DEF", "MID", "MID", "MID", "MID", "MID", "MID", "FWD", "FWD", "FWD", "FWD"];
// Kickoff slots relative to a round's start (12:30, 15:00 x6, 17:30, 20:00 x2), in minutes.
const SLOTS = [0, 150, 150, 150, 150, 150, 150, 300, 450, 450];
const ROUNDS = 38;
const MATCH_MINUTES = 112; // 45 + 15 half-time + 45 + stoppage

function hash(s: string): number {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) h = Math.imul(h ^ s.charCodeAt(i), 16777619);
  return h >>> 0;
}
function rng(seed: string) {
  let a = hash(seed);
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

interface MockPlayer extends ProviderPlayer {
  quality: number; // 0..1
}

function buildPlayers(): MockPlayer[] {
  const out: MockPlayer[] = [];
  CLUBS.forEach((_, c) => {
    const r = rng(`club-${c}`);
    SHAPE.forEach((pos, i) => {
      const id = 1000 + c * 100 + i;
      const quality = r();
      const name = `${FIRST[Math.floor(r() * FIRST.length)]} ${LAST[Math.floor(r() * LAST.length)]}`;
      const starter = i === 0 || (i >= 2 && i < 6) || (i >= 8 && i < 12) || (i >= 14 && i < 16);
      const minutes = Math.round((starter ? 600 + quality * 300 : 50 + quality * 250));
      const g = pos === "FWD" ? 6 : pos === "MID" ? 3 : pos === "DEF" ? 0.8 : 0;
      const a = pos === "FWD" ? 2 : pos === "MID" ? 3 : pos === "DEF" ? 1 : 0;
      // A few records are deliberately incomplete to show the "unreliable = 6" rule.
      const unreliable = r() < 0.02;
      out.push({
        providerId: String(id),
        clubProviderId: String(100 + c),
        name,
        position: pos,
        seasonGoals: unreliable ? null : Math.floor(quality * g * (minutes / 900) * 1.6),
        seasonAssists: unreliable ? null : Math.floor(quality * a * (minutes / 900) * 1.6),
        seasonMinutes: unreliable ? null : minutes,
        quality,
      });
    });
  });
  return out;
}

/** Round-robin pairings (circle method), mirrored for the second half of the season. */
function pairings(): [number, number][][] {
  const n = CLUBS.length;
  const teams = Array.from({ length: n }, (_, i) => i);
  const rounds: [number, number][][] = [];
  for (let r = 0; r < n - 1; r++) {
    const pairs: [number, number][] = [];
    for (let i = 0; i < n / 2; i++) {
      const a = teams[i], b = teams[n - 1 - i];
      pairs.push(r % 2 === 0 ? [a, b] : [b, a]);
    }
    rounds.push(pairs);
    teams.splice(1, 0, teams.pop()!);
  }
  return [...rounds, ...rounds.map((rd) => rd.map(([a, b]) => [b, a] as [number, number]))];
}

interface MatchEvent {
  minute: number;
  type: "goal" | "own_goal" | "yellow" | "red" | "pen_miss" | "pen_save" | "sub";
  club: number; // club index the event belongs to (the scorer's club; own goals count for the other side)
  player: string;
  assist?: string;
  playerIn?: string;
}

interface MatchPlan {
  lineups: Record<number, { starters: string[]; subs: string[] }>;
  events: MatchEvent[];
  saves: Record<string, number>; // final save count per goalkeeper
}

export interface MockOptions {
  /** Kickoff of round 1's first match. */
  anchor: Date;
  now?: () => Date;
  /** Simulated plan limits shown on the Health page. */
  dayLimit?: number;
  minuteLimit?: number;
}

export class MockProvider implements FootballProvider {
  readonly name = "mock";
  readonly batchSize = 20;
  private players = buildPlayers();
  private schedule = pairings();
  private now: () => Date;
  private used = { day: "", count: 0 };

  constructor(private opts: MockOptions) {
    this.now = opts.now ?? (() => new Date());
  }

  callsForLiveFetch(n: number) {
    return Math.ceil(n / 20);
  }

  throttle?: () => Promise<void>;
  onCall?: (meta: CallMeta) => Promise<void>;

  /** Simulates one request: waits for the poller's pacing, then counts it. */
  private async call(endpoint: string): Promise<CallMeta> {
    if (this.throttle) await this.throttle();
    const meta = this.meta(endpoint);
    if (this.onCall) await this.onCall(meta);
    return meta;
  }

  private meta(endpoint: string): CallMeta {
    const day = this.now().toISOString().slice(0, 10);
    if (this.used.day !== day) this.used = { day, count: 0 };
    this.used.count++;
    const dayLimit = this.opts.dayLimit ?? 7500;
    return { endpoint, httpStatus: 200, ok: true, dayLimit, dayRemaining: Math.max(0, dayLimit - this.used.count), minuteLimit: this.opts.minuteLimit ?? 300, minuteRemaining: (this.opts.minuteLimit ?? 300) - 1 };
  }

  async getClubs(): Promise<ProviderResult<ProviderClub[]>> {
    return { ok: true, calls: [await this.call("teams")], data: CLUBS.map(([name, short], i) => ({ providerId: String(100 + i), name, shortName: short })) };
  }

  async getPlayers(clubProviderId: string): Promise<ProviderResult<ProviderPlayer[]>> {
    const data = this.players.filter((p) => p.clubProviderId === clubProviderId).map(({ quality: _q, ...p }) => p);
    return { ok: true, calls: [await this.call(`players?team=${clubProviderId}`)], data };
  }

  /** Every fixture with its status at the current time. */
  allFixtures(): ProviderFixture[] {
    const out: ProviderFixture[] = [];
    this.schedule.forEach((pairs, r) => {
      pairs.forEach(([h, a], i) => {
        const id = `${r + 1}-${i}`;
        const kickoff = new Date(this.opts.anchor.getTime() + r * 7 * 86400_000 + SLOTS[i] * 60_000);
        out.push(this.fixtureAt(id, r + 1, h, a, kickoff));
      });
    });
    return out;
  }

  private fixtureAt(id: string, round: number, h: number, a: number, kickoff: Date): ProviderFixture {
    const elapsed = (this.now().getTime() - kickoff.getTime()) / 60_000;
    const base = { providerId: `9${String(round).padStart(2, "0")}${id.split("-")[1].padStart(2, "0")}`, round: `Regular Season - ${round}`, roundNumber: round, homeClubProviderId: String(100 + h), awayClubProviderId: String(100 + a), kickoff };
    if (elapsed < 0) return { ...base, status: "NS", minute: null, homeGoals: null, awayGoals: null };
    const minute = matchMinute(elapsed);
    const status = elapsed >= MATCH_MINUTES ? "FT" : elapsed >= 45 && elapsed < 60 ? "HT" : elapsed < 45 ? "1H" : "2H";
    const plan = this.plan(base.providerId, h, a);
    const goalsFor = (club: number) => plan.events.filter((e) => e.minute <= minute && ((e.type === "goal" && e.club === club) || (e.type === "own_goal" && e.club !== club))).length;
    return { ...base, status, minute: status === "FT" ? 90 : minute, homeGoals: goalsFor(h), awayGoals: goalsFor(a) };
  }

  async getSquad(clubProviderId: string): Promise<ProviderResult<ProviderPlayer[]>> {
    const res = await this.getPlayers(clubProviderId);
    if (!res.ok) return res;
    return { ...res, data: res.data.map((p) => ({ ...p, seasonGoals: null, seasonAssists: null, seasonMinutes: null })) };
  }

  async getFixtures(): Promise<ProviderResult<ProviderFixture[]>> {
    return { ok: true, calls: [await this.call("fixtures")], data: this.allFixtures() };
  }

  async getFixtureDetails(ids: string[]): Promise<ProviderResult<FixtureDetail[]>> {
    const all = this.allFixtures();
    const calls: CallMeta[] = [];
    for (let i = 0; i < ids.length; i += 20) calls.push(await this.call(`fixtures?ids=${ids.slice(i, i + 20).join("-")}`));
    const data: FixtureDetail[] = [];
    for (const id of ids) {
      const f = all.find((x) => x.providerId === id);
      if (!f) continue;
      if (f.status === "NS") {
        data.push({ fixture: f, players: null });
        continue;
      }
      data.push({ fixture: f, players: this.lines(f) });
    }
    return { ok: true, calls, data };
  }

  async getAccountStatus(): Promise<ProviderResult<AccountStatus>> {
    return {
      ok: true,
      calls: [await this.call("status")],
      data: { plan: "Demo (made-up data)", expires: null, active: true, requestsToday: this.used.count, dayLimit: this.opts.dayLimit ?? 7500 },
    };
  }

  private clubIndex(providerId: string) {
    return Number(providerId) - 100;
  }

  private plan(fixtureId: string, h: number, a: number): MatchPlan {
    const r = rng(`match-${fixtureId}`);
    const lineups: MatchPlan["lineups"] = {};
    const events: MatchEvent[] = [];
    const saves: Record<string, number> = {};
    for (const club of [h, a]) {
      const squad = this.players.filter((p) => this.clubIndex(p.clubProviderId) === club);
      const pick = (pos: Position, n: number) =>
        squad.filter((p) => p.position === pos).map((p) => ({ p, w: p.quality + r() * 0.6 })).sort((x, y) => y.w - x.w).map((x) => x.p).slice(0, n);
      const starters = [...pick("GK", 1), ...pick("DEF", 4), ...pick("MID", 4), ...pick("FWD", 2)];
      const rest = squad.filter((p) => !starters.includes(p) && p.position !== "GK");
      const subs = rest.sort((x, y) => y.quality - x.quality).slice(0, 3);
      lineups[club] = { starters: starters.map((p) => p.providerId), subs: subs.map((p) => p.providerId) };
      subs.forEach((s, i) => {
        if (r() < 0.85) {
          const outfield = starters.filter((p) => p.position === s.position || p.position !== "GK").filter((p) => p.position !== "GK");
          const off = outfield[Math.floor(r() * outfield.length)];
          if (!events.some((e) => e.type === "sub" && e.player === off.providerId)) events.push({ minute: 58 + i * 9 + Math.floor(r() * 6), type: "sub", club, player: off.providerId, playerIn: s.providerId });
        }
      });
    }
    const onPitch = (club: number, minute: number) => {
      const { starters, subs } = lineups[club];
      const subEvents = events.filter((e) => e.type === "sub" && e.club === club);
      const off = new Set(subEvents.filter((e) => e.minute <= minute).map((e) => e.player));
      const on = subEvents.filter((e) => e.minute <= minute).map((e) => e.playerIn!);
      const sentOff = new Set(events.filter((e) => e.type === "red" && e.minute <= minute).map((e) => e.player));
      return [...starters.filter((p) => !off.has(p)), ...on.filter((p) => subs.includes(p))].filter((p) => !sentOff.has(p));
    };
    const byId = new Map(this.players.map((p) => [p.providerId, p]));
    const weightFor = (id: string, kind: "goal" | "assist") => {
      const p = byId.get(id)!;
      const base = kind === "goal" ? { GK: 0.01, DEF: 0.12, MID: 0.35, FWD: 0.7 } : { GK: 0.03, DEF: 0.25, MID: 0.55, FWD: 0.35 };
      return base[p.position] * (0.4 + p.quality);
    };
    const choose = (ids: string[], kind: "goal" | "assist") => {
      const ws = ids.map((id) => weightFor(id, kind));
      let x = r() * ws.reduce((s, w) => s + w, 0);
      for (let i = 0; i < ids.length; i++) if ((x -= ws[i]) <= 0) return ids[i];
      return ids[ids.length - 1];
    };
    for (const club of [h, a]) {
      const goals = Math.floor(r() * 3.2 + (club === h ? 0.3 : 0));
      for (let g = 0; g < goals; g++) {
        const minute = 3 + Math.floor(r() * 87);
        const players = onPitch(club, minute);
        if (r() < 0.05) {
          const other = club === h ? a : h;
          const victim = onPitch(other, minute).filter((id) => byId.get(id)!.position === "DEF")[0];
          if (victim) events.push({ minute, type: "own_goal", club: other, player: victim });
          continue;
        }
        const scorer = choose(players, "goal");
        const assist = r() < 0.75 ? choose(players.filter((p) => p !== scorer), "assist") : undefined;
        events.push({ minute, type: "goal", club, player: scorer, assist });
      }
      const cards = Math.floor(r() * 3);
      for (let c = 0; c < cards; c++) {
        const minute = 10 + Math.floor(r() * 80);
        const pl = onPitch(club, minute).filter((id) => byId.get(id)!.position !== "GK");
        const who = pl[Math.floor(r() * pl.length)];
        if (!who) continue;
        events.push({ minute, type: r() < 0.06 ? "red" : "yellow", club, player: who });
      }
      if (r() < 0.06) {
        const minute = 20 + Math.floor(r() * 60);
        const taker = onPitch(club, minute).filter((id) => byId.get(id)!.position === "FWD")[0];
        const other = club === h ? a : h;
        const keeper = lineups[other].starters[0];
        if (taker) {
          events.push({ minute, type: "pen_miss", club, player: taker });
          if (r() < 0.6) events.push({ minute, type: "pen_save", club: other, player: keeper });
        }
      }
      saves[lineups[club].starters[0]] = Math.floor(r() * 7);
    }
    events.sort((x, y) => x.minute - y.minute);
    return { lineups, events, saves };
  }

  private lines(f: ProviderFixture): ProviderPlayerLine[] {
    const h = this.clubIndex(f.homeClubProviderId), a = this.clubIndex(f.awayClubProviderId);
    const plan = this.plan(f.providerId, h, a);
    const minute = f.status === "FT" ? 90 : f.minute ?? 0;
    const byId = new Map(this.players.map((p) => [p.providerId, p]));
    const out: ProviderPlayerLine[] = [];
    for (const club of [h, a]) {
      const { starters, subs } = plan.lineups[club];
      for (const id of [...starters, ...subs]) {
        const p = byId.get(id)!;
        const ev = plan.events.filter((e) => e.minute <= minute);
        const subOff = ev.find((e) => e.type === "sub" && e.player === id)?.minute;
        const subOn = ev.find((e) => e.type === "sub" && e.playerIn === id)?.minute;
        const redAt = ev.find((e) => e.type === "red" && e.player === id)?.minute;
        let mins: number;
        if (starters.includes(id)) mins = Math.min(subOff ?? minute, redAt ?? minute);
        else mins = subOn !== undefined ? Math.max(1, Math.min(minute, redAt ?? minute) - subOn) : 0;
        const count = (t: MatchEvent["type"]) => ev.filter((e) => e.type === t && e.player === id).length;
        const isKeeper = p.position === "GK";
        out.push({
          playerProviderId: id,
          playerName: p.name,
          position: p.position,
          clubProviderId: p.clubProviderId,
          minutes: mins,
          goals: count("goal"),
          assists: ev.filter((e) => e.type === "goal" && e.assist === id).length,
          saves: isKeeper && starters.includes(id) ? Math.round((plan.saves[id] ?? 0) * Math.min(1, minute / 90)) : 0,
          yellow: Math.min(1, count("yellow")),
          red: count("red"),
          ownGoals: count("own_goal"),
          penSaved: count("pen_save"),
          penMissed: count("pen_miss"),
        });
      }
    }
    return out;
  }
}

function matchMinute(elapsed: number): number {
  if (elapsed < 45) return Math.max(1, Math.floor(elapsed) + 1);
  if (elapsed < 60) return 45;
  return Math.min(90, Math.floor(elapsed - 15) + 1);
}

export const MOCK_ROUND_COUNT = ROUNDS;
export const MOCK_SLOTS_MINUTES = SLOTS;
