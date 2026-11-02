import { redirect } from "next/navigation";
import { clientIp, currentUser, requestLoginLink } from "@/lib/auth";

export const dynamic = "force-dynamic";

async function send(formData: FormData) {
  "use server";
  const res = await requestLoginLink(String(formData.get("email") ?? ""), await clientIp());
  redirect(`/login?${new URLSearchParams({ m: res.message, ok: res.ok ? "1" : "0" })}`);
}

export default async function Login({ searchParams }: { searchParams: Promise<{ m?: string; ok?: string }> }) {
  if (await currentUser()) redirect("/");
  const sp = await searchParams;
  return (
    <div style={{ maxWidth: 420, margin: "40px auto" }}>
      <h1>Sign in</h1>
      <p className="sub">We will email you a link. No password needed.</p>
      {sp.m && <div className={`notice ${sp.ok === "1" ? "ok" : "error"}`}>{sp.m}</div>}
      <form action={send} className="mt">
        <label htmlFor="email">Email</label>
        <input id="email" name="email" type="email" autoComplete="email" required placeholder="you@example.com" />
        <button className="btn block mt" type="submit">Email me a link</button>
      </form>
      <p className="small mt">Far Post is invite-only. By signing in you agree to the <a className="link" href="/privacy">privacy notice</a>.</p>
    </div>
  );
}
