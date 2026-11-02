# What Ben needs to sign up for

Prices are the spec's figures checked on 1 November 2026; confirm them at checkout.

| Service | What it's for | When | Cost | Setting it fills |
|---|---|---|---|---|
| **GitHub** | Stores the code | Now | Free | (repository) |
| **Render** | Runs the website, the poller and the database | When you want it online | Website $7 + poller $7 + database $6 + storage ~$1.50 ≈ **$21.50/month** | creates `DATABASE_URL`; you enter `APP_URL`, `ADMIN_EMAILS` |
| **Resend** | Sends sign-in emails | Before inviting anyone | Free up to 3,000/month, 100/day | `RESEND_API_KEY`, `EMAIL_FROM` |
| **A domain name** | Nicer address + sending email | Before inviting anyone | ~$1/month (renewal price to verify) | `APP_URL`, `EMAIL_FROM` |
| **API-Football** (direct, not RapidAPI) | Real fixtures, players, live stats | Free now for testing; **Pro** ~10 days before launch | Free $0, then Pro **$19/month**, prepaid, no auto-renew | `API_FOOTBALL_KEY`, `FOOTBALL_PROVIDER=api-football`, `API_FOOTBALL_PLAN` |

Total at launch for ~50 players: about **$41.50/month**.

Fallback only if Render's shared addresses get blocked by API-Football: move the poller to Fly.io (~$7.39/month, replacing Render's $7 poller).

## Sign-up checks (before buying Pro)

Confirm and send the builder any differences **before buying**:

- Direct Pro price is $19/month, with 7,500 requests/day and 300/minute.
- How expiry works (prepaid, no automatic renewal; what happens on expiry).
- Which seasons the Free plan allows (Free-season years are still to verify).
- Current coverage for the league: player statistics, live goals and cards.
- Whether one call can fetch several matches (`fixtures?ids=`). If not, the game uses the budgeted per-match fallback (set `API_FOOTBALL_BATCH=false`).
- Terms and rights: payment grants no publication or competition licence (spec section 8).

If live goals or cards are missing, or rights are unresolved: postpone launch.
