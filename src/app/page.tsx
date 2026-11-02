import { currentUser } from "@/lib/auth";
import { now as gameNow } from "@/lib/clock";
import { overview, weekFixtures, fixtureState, freshness, myLeagues, picksFor } from "@/lib/services/views";
import { AutoRefresh } from "@/components/AutoRefresh";
import { StatusPill, ago, fmtDate } from "@/components/StatusPill";
import { FixtureRow } from "@/components/FixtureRow";
import { Pitch } from "@/components/Pitch";
import { pitchFromResult } from "@/components/pitchData";
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
            <span className="hero-week">Week {o.cur.number} · {user.team_name}</span>
            <StatusPill status={o.team.status} partial={o.team.detail.partial} />
          </div>
          <div className="hero-score">{o.team.points}</div>
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
          <div className="hero-top"><span className="hero-week">{o.next ? `Week ${o.next.number}` : "Far Post"}</span></div>
          <div className="hero-score plain">{o.next ? fmtDate(o.next.deadline, { weekday: "short", hour: "2-digit", minute: "2-digit" }) : "–"}</div>
          <div className="sub">{o.next ? "Deadline for your first Week" : "No Weeks scheduled yet."}</div>
        </section>
      )}

      {o.next && (
        <a className="ribbon" href="/team">
          <div><div className="label">Week {o.next.number} deadline</div><div className="num">{fmtDate(o.next.deadline)}</div></div>
          <span className="chip" style={{ background: "var(--night)", color: "#fff" }}>Pick team →</span>
        </a>
      )}

      {o.cur && o.team && (
        <>
          <h2>Your team</h2>
          <Pitch
            players={pitchFromResult(await picksFor(user.id, o.cur.number), o.team.detail)}
          />
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
                <div className={`rank${l.rank === "1" ? " r1" : ""}`}>{l.rank}</div>
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
    <div className="landing">
      <div className="big">Far<br /><span className="post">Post</span></div>
      <p className="sub" style={{ fontSize: 18, maxWidth: 440 }}>Fantasy football for friends. Pick fourteen, captain one, and watch the points land live on match day.</p>
      <div><a className="btn mt" href="/login">Sign in with email</a></div>
      <p className="small mt">Invite-only.</p>
    </div>
  );
}
