import { requireUser } from "@/lib/auth";
import { now as gameNow } from "@/lib/clock";
import { q } from "@/lib/db";
import { currentWeek } from "@/lib/services/teams";
import { freshness, postponedFixtures, weekFixtures } from "@/lib/services/views";
import { AutoRefresh } from "@/components/AutoRefresh";
import { FixtureRow } from "@/components/FixtureRow";
import { ago, fmtDate } from "@/components/StatusPill";

export const dynamic = "force-dynamic";

export default async function Matches({ searchParams }: { searchParams: Promise<{ week?: string }> }) {
  await requireUser();
  const now = await gameNow();
  const weeks = await q<{ number: number }>("SELECT number FROM weeks ORDER BY number");
  const cur = await currentWeek(now);
  const sp = await searchParams;
  const week = Number(sp.week) || cur?.number || weeks[0]?.number || 1;
  const fixtures = await weekFixtures(week);
  const postponed = await postponedFixtures();
  const fresh = await freshness(now);
  const days = new Map<string, typeof fixtures>();
  for (const f of fixtures) {
    const d = fmtDate(f.kickoff, { weekday: "long", day: "numeric", month: "long" });
    days.set(d, [...(days.get(d) ?? []), f]);
  }
  return (
    <>
      <AutoRefresh />
      <h1>Matches</h1>
      <div className="seg">
        {weeks.map((w) => (
          <a key={w.number} className={`chip${w.number === week ? " on" : ""}`} href={`/matches?week=${w.number}`}>Week {w.number}</a>
        ))}
      </div>
      <p className="small">Last update {ago(fresh.lastSuccess, now)}. Live numbers usually arrive within about 2–3 minutes.</p>
      {fresh.stale && <div className="notice warn">Live updates are delayed. Points will catch up automatically.</div>}
      {[...days.entries()].map(([day, list]) => (
        <section key={day}>
          <h2>{day}</h2>
          <div className="list">{list.map((f) => <FixtureRow key={f.id} f={f} />)}</div>
        </section>
      ))}
      {fixtures.length === 0 && <div className="empty">No matches in this Week.</div>}
      {postponed.length > 0 && (
        <section>
          <h2>Postponed, awaiting a new date</h2>
          <div className="list">{postponed.map((f) => <FixtureRow key={f.id} f={f} link={false} />)}</div>
        </section>
      )}
    </>
  );
}
