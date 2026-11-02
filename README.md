# Far Post

An original, friends-first fantasy football game: pick 14 players, score points from real matches, and compete in private leagues. Score-first screens, big numbers, system fonts, phone-friendly.

Right now it runs on a **made-up demo league** (20 invented clubs, invented players, matches that play out in real time) so everything works before any subscription. Real data drops in later by changing two settings.

---

## For Ben: what you need to do, in order

You do not need to write code. Each step is a website sign-up or copying a value into a settings box.

### 1. Put the code on GitHub (free)
Create an empty private repository called `far-post` on github.com and tell Claude its name. Claude uploads the code.

### 2. Put the game online with Render (about $20/month)
1. Sign up at [render.com](https://render.com) with your GitHub account.
2. Turn on two-step sign-in in Render's account settings.
3. Click **New + → Blueprint**, choose the `far-post` repository. Render reads `render.yaml` and offers to create three things: the website, the poller (the program that fetches match data) and the database. Click **Apply**.
4. Render asks for a few values (these are the "private settings"):
   - `APP_URL`: the address Render gives the website, e.g. `https://far-post-web.onrender.com`
   - `ADMIN_EMAILS`: your email address
   - `EMAIL_FROM`: e.g. `Far Post <login@yourdomain.com>` (see step 3)
   - `RESEND_API_KEY`: from step 3 (leave blank for now: sign-in links then appear in the website's log on Render)
   - `API_FOOTBALL_KEY`: leave blank for now
5. When it says **Live**, open the address. The demo league is not loaded automatically on Render; open the website's **Shell** tab in Render and type `npm run db:seed` once if you want the demo there.

### 3. Sign-in emails with Resend (free for small use)
1. Sign up at [resend.com](https://resend.com), add your domain (or the one you buy) and follow its DNS steps.
2. Create an API key and paste it into Render as `RESEND_API_KEY` (both the website and the poller).
3. In Resend, leave paid overages off.

### 4. Match data with API-Football (free to start, $19/month for launch)
1. Sign up **directly at [api-football.com](https://www.api-football.com)** (not through RapidAPI).
2. Copy your key from the dashboard into Render as `API_FOOTBALL_KEY`, and change `FOOTBALL_PROVIDER` from `mock` to `api-football`.
3. Keep `API_FOOTBALL_PLAN=free` while testing. About ten days before launch, buy **Pro** and change it to `pro`.
4. Before buying, check the items in [SIGNUPS.md](SIGNUPS.md) ("Sign-up checks").

### 5. Rights before inviting anyone
API payment is not a licence to show match data. Before invitations, ask API-Football and Football DataCo about the intended use (see spec section 8). Until that is settled, keep the game private.

### Every week
- Admin → Health → **Download backup**. Keep the file somewhere safe.
- Look at Admin → Health for alerts (you also get them by email).
- Renew the API-Football plan before it ends (you get a warning seven days before).

---

## What's inside

| Area | Where |
|---|---|
| Game rules (squad, lineup, transfers) | `src/lib/game/rules.ts` |
| Week deadlines, TV moves, postponements | `src/lib/game/weeks.ts` |
| Suggested prices | `src/lib/game/pricing.ts` |
| Scoring rules (editable in Admin) | `src/lib/scoring/rules.ts` |
| Scoring engine | `src/lib/scoring/engine.ts`, `src/lib/scoring/team.ts` |
| Football data adapter (demo + API-Football) | `src/lib/provider/` |
| Poller (live fetching, budgets, alerts) | `src/poller/` |
| Sign-in, sessions, two-step | `src/lib/auth/` |
| Pages | `src/app/` |
| Database tables | `migrations/` |

Only the poller talks to the data supplier. Browsers only ever talk to our own website, and the API key never leaves the server.

## Running it on a computer (for builders)

Needs Node 22 and PostgreSQL 16.

```bash
cp .env.example .env            # then edit DATABASE_URL and ADMIN_EMAILS
npm install
npm run db:migrate
npm run db:seed                 # demo league; add --reset to start again
npm run dev                     # website on http://localhost:3000
npm run poller                  # in a second terminal: live updates
```

Without `RESEND_API_KEY`, sign-in links are printed in the website's terminal. Admin pages need two-step sign-in; in development the current code is also printed there.

Tests (need a `farpost_test` database, same user):

```bash
npm test          # 41 tests, including five hand-scored squads
npm run typecheck
```

Backups: `npm run backup` writes a JSON file to `backups/`. To restore into a fresh, empty database: `npm run db:migrate`, then `npm run restore -- backups/<file>.json --yes`. Render's paid database also keeps three days of its own restore points.
