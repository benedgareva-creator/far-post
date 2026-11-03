# Build notes (for the reviewer)

Built to `far-post-spec.md` (v1). This file maps the spec's acceptance checks to code and tests, and lists what still needs real data or a decision.

## Acceptance checks (spec section 9)

| # | Check | Status | Where |
|---|---|---|---|
| 1 | Five hand-scored squads match exactly, incl. doubles, blanks, TV moves with the 7-day freeze, postponements, resumptions, abandonment, second yellows, bench and vice-captain | Automated, passing | `tests/handScored.test.ts`, `tests/unit.test.ts` (week timing) |
| 2 | Staged minutes, cancelled goals, corrections; rule edits leave past Weeks unchanged; unknown fields stay pending; valid blanks finalise | Automated, passing | `tests/game.test.ts` |
| 3 | Late, unauthorised and concurrent budget-breaking edits fail | Automated, passing (serializable transactions + row lock) | `tests/game.test.ts` |
| 4 | Simulated limits and blocks enforce pacing, stopping and alerts | Automated, passing; also clickable in Admin → Health → Demo tools | `tests/poller.test.ts` |
| 5 | Browsers make no supplier calls and see no key; 390px works; excluded assets absent; a backup restores | Checked by a headless browser run at 390px (no horizontal scroll on any page, only our own host requested, no key in pages) and a backup → fresh database → restore with matching counts. Not yet an automated test | `scripts/restore.ts` |
| 6 | Paid rehearsal from Render | **Not done**: needs Ben's accounts | – |

Test run: `npm test` → 41 passing.

## Things to verify with real API-Football data (spec section 3 "to verify")

All in `src/lib/provider/apiFootball.ts`, function `parseDetail`:

- Blank minutes in a finished match are treated as "did not play" (0). During a live match they stay pending.
- Once minutes are known, blank counters (goals, assists, saves, cards, penalties) are treated as 0.
- Own goals come only from match events (`type: Goal`, `detail: Own Goal`); `goals.total` is assumed **not** to include own goals.
- Second yellow: we score `min(yellow, 1)` and let the red replace it, so either 1 or 2 in `cards.yellow` scores the same.
- `fixtures?ids=` (batch of 20) is assumed to include `players` and `events`. If not, set `API_FOOTBALL_BATCH=false` (two calls per match).
- Error shapes: `errors.rateLimit` → back off; `errors.requests` → daily limit; `errors.token/access`, HTTP 401/403/499 → blocked.
- `/status` response fields for plan end date (`response.subscription.end`); Ben can type the date in Admin → Health if it is missing.

## Design decisions made during the build

- **Clean sheet / conceded** use the club's full-match goals against for any player with 60+ minutes (so a substituted player loses the clean sheet if the club concedes later, as the spec says).
- **Auto-subs** run once a starter's matches are all finished with zero minutes. Bench order is strict: if the next bench player's match has not finished and they have not played yet, the substitution waits rather than skipping them.
- **Vice-captain** doubles only if the captain has zero minutes and the vice-captain played.
- **Abandoned** matches are void. If the same fixture id is later rescheduled, its old numbers are cleared and the replay counts once, in its own Week. **Suspended** matches keep their original Week.
- **Corrections** after points are final are stored as "waiting" and need Ben's approval; approving uses the Week's locked rules.
- **Prices**: published once, then fixed (position too). Players appearing after publication arrive unapproved; Ben sets their price when adding them. Price bands use `floor` of each cumulative share.
- **Fetching season numbers** for prices is requested from Admin but done by the poller, so only one program ever calls the supplier.
- **Admin two-step sign-in** is built in (authenticator-app codes), on top of emailed links. Code attempts are limited per session.
- **Demo league** is invented (clubs, players, results), deterministic, and plays in real time. Admin → Health can shift its clock and simulate supplier faults.

## Not done yet / open

- Paid rehearsal, load test (50 reads/second at 5,000 players), Fly.io poller move (only if Render's addresses get blocked).
- Rights clearance (spec section 8) is Ben's step before inviting anyone.
- No manual deadline override in Admin → Weeks (read-only); deadlines come from the schedule.
- The real adapter is unit-tested against a fake server only; it has never seen a real response.

## Codex review fixes (2026-11-03)

A single read-only Codex review found 16 problems. All are fixed, each with a regression test in `tests/review.test.ts` (61 tests pass in total).

1. **Critical. Edits after a deadline leaked into the closed Week.** Every edit now copies the team into any Week whose deadline has passed but which the poller has not locked yet. It does this under the team's row lock and re-reads the clock after the lock.
2. **A lineup save could bring back a sold player.** Lineup saves now take the same lock as transfers and run serializably.
3. **Missing stats counted as "did not play".** A player's participation is known only from their own minutes, or from their club's list arriving without them. Until then auto-subs and the vice-captain wait. A match cannot become final until both clubs' lists have arrived.
4. **Incomplete data at 72 hours stayed provisional for ever.** A recheck now counts only if the match came back. A match left out of the reply is retried after 15 minutes. A match still incomplete after 72 hours is retried every 6 hours for up to 14 days, with an alert. There is also an extra 7-day recheck.
5. **Later corrections were missed.** A changed final score is held as a "score" correction. Approving it rescores every player in the match and every team, in one transaction. Admin > Corrections can also fetch any match again.
6. **Wrong Week for a match first seen live.** The Week is fixed only when the match is first seen started, using that update's kickoff.
7. **Supplier stops and budgets applied too late.** Every request is now checked before it is sent and recorded the moment it returns. A block, a rate limit or a used-up day stops the rest of the pass. "Day exhausted" stops all requests until midnight UTC. Background jobs stop at 90% of the day.
8. **Not invite-only.** Only invited emails, existing players and admins can sign in. Ben invites people from Admin > People.
9. **Seven-day freeze bypass.** The stored deadline freezes once it is within seven days, before any schedule change is applied. Freezing also runs every poller pass.
10. **Real-data startup.** Daily jobs load clubs and squads before the fixture list. Admin > Weeks has a "Before launch" checklist and sets the launch round, which is allowed only until the first Week locks.
11. **Inconsistent backups.** The export runs as one read-only snapshot. Invites are included and restored too.
12. **Transfers that only work together.** Club limits and the budget are now checked on the whole batch of transfers. Problems show as warnings and block Confirm.
13. **Players could not see the rules.** A new `/rules` page shows this Week's rules and any dated upcoming changes. The player market shows each club's opponents for the Week, including doubles and blanks.
14. **Time zone.** Every time is labelled GMT or BST.
15. **Email allowance.** Every email is counted against the daily and monthly limits (`EMAIL_DAY_LIMIT`, `EMAIL_MONTH_LIMIT`). Sign-in links and invites stop short of the limit so alerts still go out. Failed alert emails are retried up to 5 times. The sign-in limits can no longer be beaten by many requests sent at once.
16. **Tied ranks.** Teams level on points share a rank (shown "=1") in both the table and the league card.
