import { currentUser } from "@/lib/auth";
import { now as gameNow } from "@/lib/clock";
import { overview, weekFixtures, fixtureState, freshness, myLeagues, picksFor } from "@/lib/services/views";
import { AutoRefresh } from "@/components/AutoRefresh";
import { StatusPill, ago, fmtDate } from "@/components/StatusPill";
import { FixtureRow } from "@/components/FixtureRow";
import { redirect } from "next/navigation";

export const dynamic = "force-dynamic";

export default async function Home() {
  const user = await currentUser();
  if (!user) return <Landing />;
  if (!user.team_name) redirect("/welcome");
  const now = await gameNow();
  const o = await overview(user.id, now);
  const fresh = await freshness(now);
  const fixtures = o.cur ? await weekFixtures(o.cur.number) : [];
  const leagues = await myLeagues(user.id);
  const live = fixtures.filter((f) => fixtureState(f).live);
  const squad = await picksFor(user.id, null);
  const players = o.team?.detail.players ?? [];
  const names = o.cur ? new Map((await picksFor(user.id, o.cur.number)).map((p) => [p.player_id, p])) : new Map();

  return (
    <>
      <AutoRefresh />
      {fresh.stale && <div className="notice warn mt">Live updates are delayed: last successful update {ago(fresh.lastSuccess, now)}. Points will catch up automatically.</div>}

      {!squad.length && (
        <div className="notice mt">
          You have no squad yet. <a className="link" href="/transfers">Pick your 14 players</a> before the next deadline{o.next ? ` (${fmtDate(o.next.deadline)})` : ""}.
        </div>
      )}

      {o.cur && o.team ? (
        <section className="hero">
          <div className="hero-top">
            <span style={{ fontWeight: 700 }}>Week {o.cur.number}</span>
            <StatusPill status={o.team.status} partial={o.team.detail.partial} />
          </div>
          <div className="hero-score">{o.team.points}</div>
          <div className="sub">{user.team_name}</div>
          <div className="hero-meta">
            <div className="stat"><span className="num">{o.average ?? "–"}</span><span>Average</span></div>
            <div className="stat"><span className="num">{o.highest ?? "–"}</span><span>Highest</span></div>
            <div className="stat"><span className="num">{o.total}</span><span>Season total</span></div>
          </div>
          <div className="small mt">
            {o.team.status === "live" ? "Partial live points: totals change as matches are played and numbers arrive." : o.team.status === "provisional" ? "Provisional until 72 hours after full time with complete data." : "Final."}
            {" "}Updated {ago(fresh.lastSuccess, now)}.
          </div>
        </section>
      ) : (
        <section className="hero">
          <div className="hero-top"><span style={{ fontWeight: 700 }}>{o.next ? `Week ${o.next.number}` : "Far Post"}</span></div>
          <div className="hero-score" style={{ fontSize: 44 }}>{o.next ? fmtDate(o.next.deadline, { weekday: "short", hour: "2-digit", minute: "2-digit" }) : "–"}</div>
          <div className="sub">{o.next ? "Deadline for your first Week" : "No Weeks scheduled yet."}</div>
        </section>
      )}

      {o.next && o.cur && (
        <div className="spread mt small">
          <span>Next deadline: Week {o.next.number}</span>
          <span className="num" style={{ color: "var(--text)" }}>{fmtDate(o.next.deadline)}</span>
        </div>
      )}

      {players.length > 0 && (
        <>
          <h2>Your players this Week</h2>
          <div className="list">
            {[...players]
              .filter((p) => p.counted)
              .sort((a, b) => b.points * b.multiplier - a.points * a.multiplier)
              .slice(0, 5)
              .map((p) => {
                const info = names.get(p.playerId);
                return (
                  <div className="row" key={p.playerId}>
                    <span className="pos">{info?.position}</span>
                    <div className="grow">
                      <div className="title">{info?.name} {p.multiplier === 2 && <span className="badge">C</span>}</div>
                      <div className="meta">{info?.club} · {p.minutes}′{p.subbedIn ? " · came off the bench" : ""}</div>
                    </div>
                    <div className="pts">{p.points * p.multiplier}</div>
                  </div>
                );
              })}
            <a className="row" href={`/team?week=${o.cur?.number}`}><div className="grow link" style={{ color: "var(--accent)", fontWeight: 600 }}>See full team</div></a>
          </div>
        </>
      )}

      {fixtures.length > 0 && (
        <>
          <h2>{live.length ? "Live now" : `Week ${o.cur!.number} matches`}</h2>
          <div className="list">
            {(live.length ? live : fixtures.slice(0, 6)).map((f) => <FixtureRow key={f.id} f={f} />)}
            <a className="row" href="/matches"><div className="grow" style={{ color: "var(--accent)", fontWeight: 600 }}>All matches</div></a>
          </div>
        </>
      )}

      {leagues.length > 0 && (
        <>
          <h2>Leagues</h2>
          <div className="list">
            {leagues.map((l) => (
              <a className="row" key={l.id} href={`/leagues/${l.id}`}>
                <div className="rank num">{l.rank}</div>
                <div className="grow"><div className="title">{l.name}</div><div className="meta">{l.members} teams</div></div>
                <div className="pts">{l.total}</div>
              </a>
            ))}
          </div>
        </>
      )}
    </>
  );
}

function Landing() {
  return (
    <div style={{ maxWidth: 520, margin: "48px auto", textAlign: "center" }}>
      <div className="hero-score" style={{ fontSize: 64 }}>Far Post</div>
      <p className="sub" style={{ fontSize: 18 }}>A fantasy football game for friends. Pick 14 players, score points from real matches, and beat your mates in private leagues.</p>
      <a className="btn mt" href="/login">Sign in with email</a>
      <p className="small mt">Invite-only.</p>
    </div>
  );
}
