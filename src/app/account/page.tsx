import { redirect } from "next/navigation";
import { q } from "@/lib/db";
import { requireUser, signOut } from "@/lib/auth";

export const dynamic = "force-dynamic";

async function rename(formData: FormData) {
  "use server";
  const user = await requireUser();
  const name = String(formData.get("team") ?? "").trim().slice(0, 40);
  if (name.length >= 2) await q("UPDATE users SET team_name = $2 WHERE id = $1", [user.id, name]);
  redirect("/account?saved=1");
}

async function out() {
  "use server";
  await signOut();
  redirect("/login");
}

async function remove(formData: FormData) {
  "use server";
  const user = await requireUser();
  if (String(formData.get("confirm")) !== "DELETE") redirect("/account?e=1");
  await q("UPDATE leagues SET owner_id = NULL WHERE owner_id = $1", [user.id]);
  await q("DELETE FROM login_tokens WHERE email = $1", [user.email]);
  await q("DELETE FROM users WHERE id = $1", [user.id]); // cascades to sessions, squad, picks, transfers, points, memberships
  await signOut();
  redirect("/login?ok=1&m=" + encodeURIComponent("Your account has been deleted."));
}

export default async function Account({ searchParams }: { searchParams: Promise<{ saved?: string; e?: string }> }) {
  const user = await requireUser();
  const sp = await searchParams;
  return (
    <div className="stack">
      <h1>Account</h1>
      {sp.saved && <div className="notice ok">Saved.</div>}
      <div className="card">
        <div className="small">Signed in as</div>
        <div style={{ fontWeight: 600 }}>{user.email}</div>
        <form action={rename}>
          <label htmlFor="team">Team name</label>
          <input id="team" name="team" defaultValue={user.team_name ?? ""} maxLength={40} />
          <button className="btn secondary mt" type="submit">Save name</button>
        </form>
      </div>
      <form action={out}><button className="btn secondary block" type="submit">Sign out</button></form>
      <h2>Delete account</h2>
      <div className="card">
        <p className="small" style={{ marginTop: 0 }}>This permanently removes your email, team, picks and league places. Type DELETE to confirm.</p>
        {sp.e && <div className="notice error">Type DELETE in capitals to confirm.</div>}
        <form action={remove}>
          <input name="confirm" placeholder="DELETE" autoComplete="off" />
          <button className="btn danger block mt" type="submit">Delete my account</button>
        </form>
      </div>
      <p className="small"><a className="link" href="/privacy">Privacy notice</a></p>
    </div>
  );
}
