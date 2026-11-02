-- Far Post initial schema

CREATE TABLE users (
  id            serial PRIMARY KEY,
  email         text NOT NULL UNIQUE,
  team_name     text,
  is_admin      boolean NOT NULL DEFAULT false,
  joined_week   integer,               -- first week this team plays
  totp_secret   text,                  -- admin two-step sign-in (base32)
  created_at    timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE login_tokens (
  id          serial PRIMARY KEY,
  email       text NOT NULL,
  token_hash  text NOT NULL UNIQUE,
  expires_at  timestamptz NOT NULL,
  used_at     timestamptz,
  ip          text,
  created_at  timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX login_tokens_email_idx ON login_tokens (email, created_at);
CREATE INDEX login_tokens_ip_idx ON login_tokens (ip, created_at);

CREATE TABLE sessions (
  id            serial PRIMARY KEY,
  user_id       integer NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  token_hash    text NOT NULL UNIQUE,
  second_factor boolean NOT NULL DEFAULT false,
  expires_at    timestamptz NOT NULL,
  created_at    timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE clubs (
  id           serial PRIMARY KEY,
  provider_id  text NOT NULL UNIQUE,
  name         text NOT NULL,
  short_name   text NOT NULL
);

CREATE TABLE players (
  id               serial PRIMARY KEY,
  provider_id      text NOT NULL UNIQUE,
  club_id          integer NOT NULL REFERENCES clubs(id),
  name             text NOT NULL,
  position         text NOT NULL CHECK (position IN ('GK','DEF','MID','FWD')),
  price            integer CHECK (price IN (4,6,8,10)),
  suggested_price  integer,
  suggestion_note  text,
  published        boolean NOT NULL DEFAULT false,
  approved         boolean NOT NULL DEFAULT true,  -- additions after launch need approval
  season_goals     integer,
  season_assists   integer,
  season_minutes   integer
);
CREATE INDEX players_club_idx ON players (club_id);

-- Scoring rule sets. A week keeps the rule set it locked with forever.
CREATE TABLE rulesets (
  id            serial PRIMARY KEY,
  name          text NOT NULL,
  config        jsonb NOT NULL,
  status        text NOT NULL DEFAULT 'draft' CHECK (status IN ('draft','published')),
  from_week     integer,                     -- first week it applies to
  published_at  timestamptz,
  created_at    timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE weeks (
  id            serial PRIMARY KEY,
  number        integer NOT NULL UNIQUE,
  round_label   text,                        -- provider round name
  deadline      timestamptz NOT NULL,
  frozen        boolean NOT NULL DEFAULT false,  -- deadline fixed 7 days out
  locked        boolean NOT NULL DEFAULT false,  -- deadline passed, teams snapshotted
  ruleset_id    integer REFERENCES rulesets(id),
  status        text NOT NULL DEFAULT 'upcoming' CHECK (status IN ('upcoming','live','provisional','final'))
);

CREATE TABLE fixtures (
  id            serial PRIMARY KEY,
  provider_id   text NOT NULL UNIQUE,
  round_label   text,
  home_club_id  integer NOT NULL REFERENCES clubs(id),
  away_club_id  integer NOT NULL REFERENCES clubs(id),
  kickoff       timestamptz NOT NULL,
  week_number   integer,                     -- by actual kickoff; kept once started
  status        text NOT NULL DEFAULT 'NS',  -- NS, LIVE, HT, FT, PST, SUSP, INT, ABD, CANC, TBD
  minute        integer,
  home_goals    integer,
  away_goals    integer,
  finished_at   timestamptz,
  data_complete boolean NOT NULL DEFAULT false,
  last_fetched  timestamptz,
  recheck_stage integer NOT NULL DEFAULT 0,  -- 0 none, 1 = 30m done, 2 = 24h done, 3 = 72h done
  started       boolean NOT NULL DEFAULT false
);
CREATE INDEX fixtures_week_idx ON fixtures (week_number);
CREATE INDEX fixtures_kickoff_idx ON fixtures (kickoff);

-- Latest known statistics for one player in one fixture. NULL = not known yet.
CREATE TABLE player_match_stats (
  fixture_id   integer NOT NULL REFERENCES fixtures(id) ON DELETE CASCADE,
  player_id    integer NOT NULL REFERENCES players(id),
  club_id      integer NOT NULL REFERENCES clubs(id),
  minutes      integer,
  goals        integer,
  assists      integer,
  saves        integer,
  yellow       integer,
  red          integer,
  own_goals    integer,
  pen_saved    integer,
  pen_missed   integer,
  updated_at   timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (fixture_id, player_id)
);

-- Points for one player in one fixture, scored with the week's rules.
CREATE TABLE player_points (
  fixture_id   integer NOT NULL REFERENCES fixtures(id) ON DELETE CASCADE,
  player_id    integer NOT NULL REFERENCES players(id),
  week_number  integer NOT NULL,
  points       integer NOT NULL,
  minutes      integer NOT NULL DEFAULT 0,
  breakdown    jsonb NOT NULL,
  pending      jsonb NOT NULL DEFAULT '[]',
  status       text NOT NULL CHECK (status IN ('live','provisional','final')),
  ruleset_id   integer NOT NULL REFERENCES rulesets(id),
  updated_at   timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (fixture_id, player_id)
);
CREATE INDEX player_points_week_idx ON player_points (week_number);

-- A team's current squad (what you own right now).
CREATE TABLE squad_players (
  user_id        integer NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  player_id      integer NOT NULL REFERENCES players(id),
  purchase_price integer NOT NULL,
  PRIMARY KEY (user_id, player_id)
);

-- Lineup: slot 1-11 starters, 12 = reserve goalkeeper, 13-14 outfield bench in order.
-- week_number NULL = the editable lineup for the next deadline.
CREATE TABLE picks (
  id          serial PRIMARY KEY,
  user_id     integer NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  week_number integer,
  player_id   integer NOT NULL REFERENCES players(id),
  slot        integer NOT NULL CHECK (slot BETWEEN 1 AND 14),
  is_captain  boolean NOT NULL DEFAULT false,
  is_vice     boolean NOT NULL DEFAULT false,
  price       integer NOT NULL
);
CREATE UNIQUE INDEX picks_slot_uniq ON picks (user_id, COALESCE(week_number, -1), slot);
CREATE UNIQUE INDEX picks_player_uniq ON picks (user_id, COALESCE(week_number, -1), player_id);

CREATE TABLE transfers (
  id          serial PRIMARY KEY,
  user_id     integer NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  week_number integer NOT NULL,             -- week whose deadline it counts toward
  player_out  integer NOT NULL REFERENCES players(id),
  player_in   integer NOT NULL REFERENCES players(id),
  price_out   integer NOT NULL,
  price_in    integer NOT NULL,
  free_period boolean NOT NULL DEFAULT false,
  created_at  timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE team_week_points (
  user_id     integer NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  week_number integer NOT NULL,
  points      integer NOT NULL,
  detail      jsonb NOT NULL,
  status      text NOT NULL,
  updated_at  timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (user_id, week_number)
);

CREATE TABLE leagues (
  id          serial PRIMARY KEY,
  name        text NOT NULL,
  code        text NOT NULL UNIQUE,
  owner_id    integer REFERENCES users(id) ON DELETE SET NULL,
  start_week  integer NOT NULL,
  created_at  timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE league_members (
  league_id  integer NOT NULL REFERENCES leagues(id) ON DELETE CASCADE,
  user_id    integer NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  joined_at  timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (league_id, user_id)
);

-- Changes found after points became final. Ben approves or rejects each one.
CREATE TABLE corrections (
  id           serial PRIMARY KEY,
  fixture_id   integer NOT NULL REFERENCES fixtures(id) ON DELETE CASCADE,
  player_id    integer NOT NULL REFERENCES players(id),
  old_stats    jsonb NOT NULL,
  new_stats    jsonb NOT NULL,
  old_points   integer NOT NULL,
  new_points   integer NOT NULL,
  status       text NOT NULL DEFAULT 'waiting' CHECK (status IN ('waiting','approved','rejected')),
  decided_by   integer REFERENCES users(id) ON DELETE SET NULL,
  decided_at   timestamptz,
  created_at   timestamptz NOT NULL DEFAULT now()
);

-- Every request to the football data supplier (for budgets and Health page).
CREATE TABLE api_requests (
  id               bigserial PRIMARY KEY,
  at               timestamptz NOT NULL DEFAULT now(),
  utc_day          date NOT NULL DEFAULT (now() AT TIME ZONE 'utc')::date,
  endpoint         text NOT NULL,
  purpose          text NOT NULL,          -- live | background | correction
  http_status      integer,
  ok               boolean NOT NULL,
  day_limit        integer,
  day_remaining    integer,
  minute_limit     integer,
  minute_remaining integer,
  error            text
);
CREATE INDEX api_requests_day_idx ON api_requests (utc_day);

CREATE TABLE alerts (
  id          serial PRIMARY KEY,
  at          timestamptz NOT NULL DEFAULT now(),
  level       text NOT NULL CHECK (level IN ('info','warning','critical')),
  kind        text NOT NULL,
  message     text NOT NULL,
  emailed     boolean NOT NULL DEFAULT false,
  resolved_at timestamptz
);

CREATE TABLE admin_log (
  id        serial PRIMARY KEY,
  at        timestamptz NOT NULL DEFAULT now(),
  user_id   integer REFERENCES users(id) ON DELETE SET NULL,
  action    text NOT NULL,
  details   jsonb NOT NULL DEFAULT '{}'
);

CREATE TABLE settings (
  key    text PRIMARY KEY,
  value  jsonb NOT NULL
);
