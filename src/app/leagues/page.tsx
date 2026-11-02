import { redirect } from "next/navigation";
import { requireUser } from "@/lib/auth";
import { now as gameNow } from "@/lib/clock";
import { q } from "@/lib/db";
import { createLeague, joinLeague } from "@/lib/services/leagues";
import { GameError, upcomingWeek } from "@/lib/services/teams";
import { myLeagues } from "@/lib/services/views";

export const dynamic = "force-dynamic";

async function create(formData: FormData) {
  "use server";
  const user = await requireUser();
  try {
    const l = await createLeague(user.id, String(formData.get("name") ?? ""), Number(formData.get("start")));
    redirect(`/leagues/${l.id}?new=1`);
  } catch (e) {
    if (e instanceof GameError) redirect(`/leagues?e=${encodeURIComponent(e.message)}`);
    throw e;
  }
}

async function join(formData: FormData) {
  "use server";
  const user = await requireUser();
  try {
    const l = await joinLeague(user.id, String(formData.get("code") ?? ""));
    redirect(`/leagues/${l.id}`);
  } catch (e) {
    if (e instanceof GameError) redirect(`/leagues?e=${encodeURIComponent(e.message)}`);
    throw e;
  }
}

export default async function Leagues({ searchParams }: { searchParams: Promise<{ e?: string }> }) {
  const user = await requireUser();
  const now = await gameNow();
  const leagues = await myLeagues(user.id);
  const weeks = await q<{ number: number }>("SELECT number FROM weeks ORDER BY number");
  const next = await upcomingWeek(now);
  const { e } = await searchParams;
  return (
    <>
      <h1>Leagues</h1>
      {e && <div className="notice error">{e}</div>}
      <div className="list mt">
        {leagues.map((l) => (
          <a className="row" key={l.id} href={`/leagues/${l.id}`}>
            <div className={`rank${l.rank === "1" ? " r1" : ""}`}>{l.rank}</div>
            <div className="grow"><div className="title">{l.name}</div><div className="meta">{l.members} teams · from Week {l.start_week}</div></div>
            <div className="pts">{l.total}</div>
          </a>
        ))}
        {leagues.length === 0 && <div className="empty">You are not in a league yet. Join one with a code or start your own.</div>}
      </div>
      <h2>Join with a code</h2>
      <form action={join} className="card" style={{ display: "flex", gap: 10 }}>
        <input name="code" placeholder="e.g. FARPOST1" required maxLength={12} style={{ textTransform: "uppercase" }} aria-label="Invite code" />
        <button className="btn" type="submit">Join</button>
      </form>
      <h2>Start a league</h2>
      <form action={create} className="card">
        <label htmlFor="name" style={{ marginTop: 0 }}>Name</label>
        <input id="name" name="name" required maxLength={50} placeholder="e.g. Office league" />
        <label htmlFor="start">Count points from</label>
        <select id="start" name="start" defaultValue={next?.number ?? weeks[0]?.number}>
          {weeks.map((w) => <option key={w.number} value={w.number}>Week {w.number}</option>)}
        </select>
        <button className="btn block mt" type="submit">Create league</button>
      </form>
    </>
  );
}
