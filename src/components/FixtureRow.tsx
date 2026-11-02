import { fixtureState, type FixtureView } from "@/lib/services/views";
import { fmtDate } from "./StatusPill";

export function FixtureRow({ f, link = true }: { f: FixtureView; link?: boolean }) {
  const st = fixtureState(f);
  const started = f.home_goals !== null && f.away_goals !== null && !["NS", "PST", "TBD", "CANC"].includes(f.status);
  const inner = (
    <>
      <div className="team">{f.home}</div>
      <div>
        <div className="score">{started ? `${f.home_goals}–${f.away_goals}` : fmtDate(f.kickoff, { hour: "2-digit", minute: "2-digit" })}</div>
        <div className={`when${st.live ? " live" : ""}`}>{st.label || fmtDate(f.kickoff, { weekday: "short", day: "numeric", month: "short" })}</div>
      </div>
      <div className="team away">{f.away}</div>
    </>
  );
  return link ? <a className="match" href={`/matches/${f.id}`}>{inner}</a> : <div className="match">{inner}</div>;
}
