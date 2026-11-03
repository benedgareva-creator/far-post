# Far Post: v1 spec for Ben

**Assumptions:** friends-first and a mid-season start are workable, subject to the rights checks in section 8; Ben pays about **$42/month** and needs paid match data. Growth needs permissions and a load test. A phone-friendly website fits v1; native apps are excluded. Vendor prices were checked on 1 November 2026; checkout entitlements and real data remain **to verify**.

## 1. Name and design

**Far Post**; alternatives **Second Ball** and **Late Winner**. Check trademarks and domains. Use original score-first lists, large numbers, restrained colour and system fonts, inspired by Apple Sports' simplicity. Call gameweeks "Weeks".

## 2. Game rules

Squad: 14 players (2 goalkeepers, 4 defenders, 5 midfielders, 3 forwards) within 100 credits. Start **11**, with exactly one goalkeeper, at least 3 defenders, 3 midfielders and 1 forward. Maximum three per club when buying.

Our prices are 4/6/8/10. Suggest them using goal points × this season's Premier League goals + 4 × assists + minutes/90. Rank within positions: top 5% cost 10, next 15% 8, next 30% 6, rest 4; ties use player ID. Unreliable records default to 6. Ben reviews and publishes; prices and positions then stay fixed. Ben approves additions; selling returns the purchase price.

Unlimited transfers before your first deadline, then two weekly, without carry-over or paid extras. Captain doubles the week's points; vice-captain replaces a captain with zero minutes.

Weeks run deadline-to-deadline, initially one hour before each round's first kickoff. Times follow schedules until seven days away, then freeze. Fixtures count by actual kickoff: doubles score both matches; postponements follow their new kickoff without holding the old week open. Resumptions retain their original week; abandoned games are void and replays count once.

Carry teams forward; hide rivals' choices until deadline. Once participation is resolved, replace non-playing starters in bench order, preserving formation; the reserve goalkeeper replaces only a goalkeeper. Launch is Week 1, everyone starts at zero; late joiners start next deadline. Mini-leagues use invite codes and totals from a chosen week.

Exclude chips, changing prices, cups, head-to-head, injury news, notifications, prizes and automatic season rollover.

## 3. Scoring engine

Ben edits points, thresholds and eligible positions, previews last week and publishes for the next unlocked week. Rule edits never rescore past weeks. Corrections use original rules and locked teams. New measures need builder work; unsupported measures can be disabled before launch.

Fields are [documented](https://www.api-football.com/documentation_v3); actual coverage and blank-value meanings remain **to verify**. Club conceded uses the opponent's fixture `goals.home` or `goals.away`. GK/DEF/MID/FWD mean goalkeeper/defender/midfielder/forward.

| Measure | Points | Source |
|---|---|---|
| 1–59 / 60+ minutes | 1 / 2 total | `games.minutes` |
| Goal: GK/DEF, MID, FWD | 7, 6, 5 | `goals.total` |
| Assist | 4 | `goals.assists` |
| Clean sheet: GK/DEF, MID | 5, 1 | Derived: 60+ minutes; club concedes zero |
| Each two conceded, GK/DEF | −1 | Derived: 60+ minutes; club score |
| Each four saves, GK | 1 | `goals.saves` |
| Yellow / sending-off | −1 / −3 | `cards.yellow`, `cards.red`; red replaces yellow |
| Own goal | −2 | Own-goal event |
| Penalty saved / missed | 5 / −2 | `penalty.saved`, `penalty.missed` |

For saves and conceded goals, count complete blocks per match. Substituted players lose clean sheets if the club later concedes. Never count events and statistics twice. Missing required data stays pending; the builder validates which blanks mean zero or not applicable.

## 4. Live scoring

Fetch every 60 seconds; pages refresh saved points every 30. Expected delay: provider 60s + fetch 60s + page 30s = **150 seconds**, plus source lag; target under five minutes, not guaranteed. Show last successful fetch; warn after three minutes without one. [Documented update behaviour](https://www.api-football.com/news/post/how-to-get-started-with-api-football-the-complete-beginners-guide)

Goals and cards must work live. Otherwise launch waits. Label late components **pending** and scores **partial live points**. Clean-sheet points appear at 60 minutes only when current data supports them.

Points stay **provisional** until 72 hours after full time and complete data, then turn **final**. Rechecks after 30 minutes, 24 hours and 72 hours correct them automatically. Later corrections need Ben's logged approval and update league totals.

## 5. API-Football

Build on Free; buy **Pro directly, not through RapidAPI**, about ten days before launch for rehearsal. [Direct plans](https://www.api-football.com/terms) are prepaid without automatic renewal or overages; quota resets at midnight UTC. Ben renews monthly; expiry returns to Free and can stop live access. Health checks [status](https://api-sports.io/documentation/football/v3) daily and warns seven days before expiry; Ben enters the date if unavailable.

Sixty seconds matches documented player-stat updates. Allow 180 minutes per match. Kickoffs 12:30, 15:00, 17:30, 20:00 with 1/6/1/2 matches give 630 active minutes and 10 × 180 = 1,800 match-minutes. Background allowance = fixture list 1 + coverage 1 + squads 20 + three correction groups × ten matches × three calls = 112.

Round upward after adding 20% for retries:

- Normal, one call fetching up to 20 matches: (630 + 112) × 1.2 = **891/day**.
- Fallback, separate calls per match: (630 + 2 × 1,800 + 112) × 1.2 = **5,211/day**; allow 21/minute if ten matches overlap.
- Fallback at 30 seconds: (1,260 + 7,200 + 112) × 1.2 = 10,287/day; rejected.
- Quiet day: two calls; with ten corrections, (2 + 30) × 1.2 = **39**.

| [Plan](https://www.api-football.com/pricing) | $/month | [Daily / minute limits](https://www.api-football.com/news/post/how-ratelimit-works) | Normal / fallback daily use |
|---|---:|---|---|
| Free | 0 | 100 / 10 | 891% / 5,211%; fails |
| **Pro: buy** | **19** | **7,500 / 300** | **12% / 69%** |
| Ultra | 29 | 75,000 / 450 | 1.2% / 6.9% |
| Mega | 39 | 150,000 / 900 | 0.6% / 3.5% |

One server program, the **poller**, fetches for everyone; browsers never call the supplier. Prevent duplicate pollers, count requests across restarts and read the limits API-Football reports. Space calls, including retries, at most one/second and half the minute allowance; Free uses five/minute. At 80% daily usage fetch every two minutes; at 90%, five minutes; at 95%, stop live, reserving corrections. Limit replies trigger increasing waits. Blocks stop attempts and alert Ben within five minutes; he contacts API-Football. Affected points stay pending; recovery is not guaranteed.

## 6. Stack and monthly costs

- **Next.js** builds the website and its server side.
- **PostgreSQL** stores accounts, squads and points.
- **Render** runs them and the independent poller without Ben patching servers.
- **Resend** sends login emails.
- **GitHub** stores code for $0/month.

| Dollars/month, before tax | 50 players | 5,000 players |
|---|---:|---:|
| API Pro | 19 | 19 |
| [Render](https://render.com/pricing) website + poller | 7 + 7 | 25 + 7 |
| Database + storage | 6 + 1.50 | 19 + 3 |
| [Resend](https://resend.com/pricing) | 0 | 20 |
| [Extra traffic](https://render.com/docs/outbound-bandwidth) | 0 | 14.25 |
| Domain allowance | 1 | 1 |
| **Total** | **41.50** | **108.25** |

Storage allows 5/10 GB × $0.30; larger traffic assumes (100 − 5 included) GB × $0.15. Domain renewal is **to verify**. At 5,000, load-test 1,500 ÷ 30 = 50 reads/second. Build, maintenance and licence fees are extra.

Resend Free permits 3,000/month and 100/day; $20 permits 50,000/month. Use long sessions, limit attempts, alert before exhaustion and disable optional overages.

Render shares outbound internet addresses, which API-Football warns may trigger blocks. Test early and ask support; a successful test cannot guarantee future access. If needed, move only the poller to Fly.io's Ashburn region: $3.69 worker + $3.60 [outbound address](https://docs.fly.io/networking/egress-ips) + 5 GB × $0.02 = **$7.39/month**, replacing $7; allow $8 for longer months. [Fly prices](https://docs.fly.io/about/pricing). Builder secures the poller's link to the database.

## 7. Accounts and operations

Sign-in uses expiring emailed links, encrypted connections, long sessions and limited attempts. Enforce ownership, budget, transfer and deadline rules on the server. Keep keys in Render's private settings; protect Ben's admin and service accounts with two-step sign-in. Collect email and team name, explain privacy and allow deletion. Log admin changes.

Admin: Health (updates, quotas, expiry, pause), Scoring, Weeks, Players/Prices, Corrections, People/Leagues. Ben renews data, handles alerts and downloads weekly backups. Paid Render provides [three-day recovery](https://render.com/docs/postgresql-backups); builder supplies a tested restore guide.

## 8. Rights

[API payment grants no publication or competition licence](https://www.api-football.com/terms); invite-only is no automatic clearance. The [Premier League directs match-data enquiries to Football DataCo](https://www.premierleague.com/en/about/faq/other).

Before invitations, ask both about intended display, storage, backups and attribution; check necessary league, club and player permissions. A refusal stops sharing. If unclear after 14 days, seek paid legal advice. Launch only with an established lawful basis and any required permissions; consultation alone is not clearance.

Use club and player names only as cleared text, with an unofficial footer. Avoid "Premier League"/"FPL" branding, crests, kits, photos, official-game wording, layouts, prices and data, Apple's assets, fees and prizes. Obtain further advice before public or commercial expansion.

## 9. Acceptance

Before paying, capture an allowed historic round: one list + ten fixtures = **11 calls**, plus player pages within Free limits. If access is restricted, use permitted samples and staged data.

Reviewer must verify:

1. Five hand-scored squads match exactly, including doubles, blanks, TV moves respecting the seven-day freeze, postponements, resumptions, abandonment, second yellows, bench and vice-captain.
2. Staged minutes, cancelled goals and corrections work; rule edits leave past weeks unchanged; unknown fields remain pending and valid blanks finalise.
3. Late, unauthorised and concurrent budget-breaking edits fail.
4. Simulated limits and blocks enforce pacing, stopping and five-minute alerts; the website stays usable.
5. Browsers expose no supplier calls or key; 390-pixel screens work; excluded assets are absent; a backup restores.
6. Paid rehearsal from Render confirms the complete player catalogue, live goals and cards, labelled delays, request budget and 20 players' hand-checked final points.

## 10. Ben's questions

Recommended defaults:

1. Name: Far Post.
2. Access: invite-only.
3. Launch: after rehearsal and rights checks.
4. Partial live points acceptable: yes, labelled.

## 11. Sign-up checks

Ben confirms direct $19/month pricing, 7,500/day and 300/minute, expiry, allowed seasons, current coverage, batching and rights. Free-season years remain **to verify**.

- **Missing Free data:** use permitted samples.
- **Batching unavailable:** use the budgeted fallback.
- **Different price, quotas or terms:** send the figures to the builder or reviewer for a revised budget **before buying**.
- **Missing live goals or cards, or unresolved rights:** postpone launch.
