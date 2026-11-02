import { redirect } from "next/navigation";
import { q } from "@/lib/db";
import { requireUser } from "@/lib/auth";

export const dynamic = "force-dynamic";

async function save(formData: FormData) {
  "use server";
  const user = await requireUser();
  const name = String(formData.get("team") ?? "").trim().slice(0, 40);
  if (name.length < 2) redirect("/welcome?e=1");
  if (formData.get("privacy") !== "on") redirect("/welcome?e=2");
  await q("UPDATE users SET team_name = $2 WHERE id = $1", [user.id, name]);
  redirect("/transfers");
}

export default async function Welcome({ searchParams }: { searchParams: Promise<{ e?: string }> }) {
  const user = await requireUser();
  if (user.team_name) redirect("/");
  const { e } = await searchParams;
  return (
    <div style={{ maxWidth: 440, margin: "32px auto" }}>
      <h1>Name your team</h1>
      <p className="sub">This is what your friends will see in leagues.</p>
      {e === "1" && <div className="notice error">Team names need at least 2 characters.</div>}
      {e === "2" && <div className="notice error">Please confirm you have read the privacy notice.</div>}
      <form action={save}>
        <label htmlFor="team">Team name</label>
        <input id="team" name="team" maxLength={40} required placeholder="e.g. Back Post Bandits" />
        <label style={{ display: "flex", gap: 10, alignItems: "flex-start", fontWeight: 400 }}>
          <input type="checkbox" name="privacy" required style={{ marginTop: 2 }} />
          <span className="small">I have read the <a className="link" href="/privacy" target="_blank">privacy notice</a>. Far Post stores my email address and team name to run the game, and I can delete my account at any time.</span>
        </label>
        <button className="btn block mt" type="submit">Continue to pick a squad</button>
      </form>
    </div>
  );
}
