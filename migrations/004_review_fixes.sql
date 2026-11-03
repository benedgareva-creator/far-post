-- Fixes from the code review (2026-11-03).

-- A match's Week is fixed the first time we see it started, using the kickoff in that same update.
ALTER TABLE fixtures ADD COLUMN week_fixed boolean NOT NULL DEFAULT false;
UPDATE fixtures SET week_fixed = true WHERE started AND week_number IS NOT NULL;

-- Rechecks: retry a match whose data is still incomplete, and let Ben ask for a fresh fetch.
ALTER TABLE fixtures ADD COLUMN retry_after timestamptz;
ALTER TABLE fixtures ADD COLUMN refetch_requested boolean NOT NULL DEFAULT false;

-- Corrections can also be a changed final score (affects clean sheets and goals conceded).
ALTER TABLE corrections ALTER COLUMN player_id DROP NOT NULL;
ALTER TABLE corrections ADD COLUMN kind text NOT NULL DEFAULT 'player' CHECK (kind IN ('player', 'score'));

-- The game is invite-only: an email must be invited before it can create an account.
CREATE TABLE invites (
  email       text PRIMARY KEY,
  invited_by  integer REFERENCES users(id) ON DELETE SET NULL,
  created_at  timestamptz NOT NULL DEFAULT now(),
  used_at     timestamptz
);
INSERT INTO invites (email, used_at) SELECT email, created_at FROM users ON CONFLICT DO NOTHING;

-- Every email sent, to keep within the email service's daily and monthly allowance.
CREATE TABLE email_log (
  id     serial PRIMARY KEY,
  at     timestamptz NOT NULL DEFAULT now(),
  kind   text NOT NULL,
  ok     boolean NOT NULL,
  error  text
);
CREATE INDEX email_log_at_idx ON email_log (at);

-- Alert emails that failed are retried a few times.
ALTER TABLE alerts ADD COLUMN email_attempts integer NOT NULL DEFAULT 0;
