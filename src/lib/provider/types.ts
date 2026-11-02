// The football data adapter. The rest of the game only talks to this interface, so
// the made-up demo league and the real API-Football service are interchangeable
// (switch with FOOTBALL_PROVIDER in .env). Only the server-side poller and admin
// tools call a provider; browsers never do.
import type { Position } from "../game/rules";

export interface ProviderClub {
  providerId: string;
  name: string;
  shortName: string;
}

export interface ProviderPlayer {
  providerId: string;
  clubProviderId: string;
  name: string;
  position: Position;
  seasonGoals: number | null;
  seasonAssists: number | null;
  seasonMinutes: number | null;
}

export interface ProviderFixture {
  providerId: string;
  round: string;
  roundNumber: number | null;
  homeClubProviderId: string;
  awayClubProviderId: string;
  kickoff: Date;
  /** API-Football short status codes: NS, 1H, HT, 2H, ET, P, FT, AET, PEN, SUSP, INT, PST, CANC, ABD, AWD, WO, TBD, LIVE */
  status: string;
  minute: number | null;
  homeGoals: number | null;
  awayGoals: number | null;
}

/** One player's numbers in one match. null = the supplier has not given it (stays pending). */
export interface ProviderPlayerLine {
  playerProviderId: string;
  playerName: string;
  position: Position | null;
  clubProviderId: string;
  minutes: number | null;
  goals: number | null;
  assists: number | null;
  saves: number | null;
  yellow: number | null;
  red: number | null;
  ownGoals: number | null;
  penSaved: number | null;
  penMissed: number | null;
}

export interface FixtureDetail {
  fixture: ProviderFixture;
  /** null when the supplier has no player statistics for this match yet. */
  players: ProviderPlayerLine[] | null;
}

export interface AccountStatus {
  plan: string | null;
  /** When the paid plan ends (null if unknown; Ben can type it in Admin > Health). */
  expires: Date | null;
  active: boolean | null;
  requestsToday: number | null;
  dayLimit: number | null;
}

/** What one HTTP call to the supplier did, for budgets and the Health page. */
export interface CallMeta {
  endpoint: string;
  httpStatus: number | null;
  ok: boolean;
  dayLimit: number | null;
  dayRemaining: number | null;
  minuteLimit: number | null;
  minuteRemaining: number | null;
  /** The supplier says we sent too many requests this minute. */
  rateLimited?: boolean;
  /** The daily allowance is used up. */
  dayExhausted?: boolean;
  /** Key rejected, account suspended or address blocked: stop and tell Ben. */
  blocked?: boolean;
  error?: string;
}

export type ProviderResult<T> = { ok: true; data: T; calls: CallMeta[] } | { ok: false; error: string; calls: CallMeta[] };

export interface FootballProvider {
  readonly name: string;
  /** Called before every HTTP request so the poller can space calls out. */
  throttle?: () => Promise<void>;
  /** Max fixtures fetched in one live call (1 = per-match fallback). */
  readonly batchSize: number;
  /** Calls one live fetch of n fixtures will cost (for the request budget). */
  callsForLiveFetch(n: number): number;
  getClubs(): Promise<ProviderResult<ProviderClub[]>>;
  /** Players with this season's totals (several calls per club; used when suggesting prices). */
  getPlayers(clubProviderId: string): Promise<ProviderResult<ProviderPlayer[]>>;
  /** Current squad list without statistics (one call per club; used by the daily refresh). */
  getSquad(clubProviderId: string): Promise<ProviderResult<ProviderPlayer[]>>;
  getFixtures(): Promise<ProviderResult<ProviderFixture[]>>;
  getFixtureDetails(fixtureProviderIds: string[]): Promise<ProviderResult<FixtureDetail[]>>;
  getAccountStatus(): Promise<ProviderResult<AccountStatus>>;
}
