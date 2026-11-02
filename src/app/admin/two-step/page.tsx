import { redirect } from "next/navigation";
import { cookies } from "next/headers";
import { markSecondFactor, requireUser, SESSION_COOKIE } from "@/lib/auth";
import { newTotpSecret, sha256, totpCode, verifyTotp } from "@/lib/auth/crypto";
import { one, q } from "@/lib/db";
import { logAdmin } from "@/lib/services/alerts";
import { config } from "@/lib/config";

export const dynamic = "force-dynamic";
const MAX_FAILURES = 5;

async function verify(formData: FormData) {
  "use server";
  const user = await requireUser();
  if (!user.is_admin) redirect("/");
  const token = (await cookies()).get(SESSION_COOKIE)?.value ?? "";
  const s = await one<{ two_step_failures: number }>("SELECT two_step_failures FROM sessions WHERE token_hash = $1", [sha256(token)]);
  if (!s || s.two_step_failures >= MAX_FAILURES) redirect("/admin/two-step?e=locked");
  let secret = user.totp_secret;
  const enrolling = !secret;
  if (enrolling) secret = String(formData.get("secret") ?? "");
  if (!secret || !verifyTotp(secret, String(formData.get("code") ?? ""))) {
    await q("UPDATE sessions SET two_step_failures = two_step_failures + 1 WHERE token_hash = $1", [sha256(token)]);
    redirect(`/admin/two-step?e=bad${enrolling ? `&s=${secret}` : ""}`);
  }
  if (enrolling) {
    await q("UPDATE users SET totp_secret = $2 WHERE id = $1", [user.id, secret]);
    await logAdmin(user.id, "enrol two-step sign-in", {});
  }
  await markSecondFactor();
  redirect("/admin");
}

export default async function TwoStep({ searchParams }: { searchParams: Promise<{ e?: string; s?: string }> }) {
  const user = await requireUser();
  if (!user.is_admin) redirect("/");
  if (user.second_factor) redirect("/admin");
  const sp = await searchParams;
  const enrolling = !user.totp_secret;
  const secret = enrolling ? (sp.s && /^[A-Z2-7]{32}$/.test(sp.s) ? sp.s : newTotpSecret()) : null;
  const known = secret ?? user.totp_secret;
  if (!config.isProduction && known) console.log(`[dev only] current two-step code: ${totpCode(known)}`);
  const uri = secret ? `otpauth://totp/Far%20Post:${encodeURIComponent(user.email)}?secret=${secret}&issuer=Far%20Post` : null;
  return (
    <div style={{ maxWidth: 460, margin: "24px auto" }} className="stack">
      <h1>Two-step sign-in</h1>
      {sp.e === "bad" && <div className="notice error">That code did not match. Try the newest code.</div>}
      {sp.e === "locked" && <div className="notice error">Too many wrong codes. Sign out and sign in again.</div>}
      {enrolling ? (
        <>
          <p className="sub">Admin pages need a second step. Open an authenticator app (Apple Passwords, Google Authenticator, 1Password…), choose “add a code” → “enter a setup key”, and type this key:</p>
          <div className="card num" style={{ fontSize: 18, letterSpacing: "0.08em", wordBreak: "break-all" }}>{secret!.match(/.{1,4}/g)!.join(" ")}</div>
          <p className="small">On a phone you can also tap <a className="link" href={uri!}>this setup link</a>.</p>
        </>
      ) : (
        <p className="sub">Enter the 6-digit code from your authenticator app.</p>
      )}
      <form action={verify}>
        {secret && <input type="hidden" name="secret" value={secret} />}
        <label htmlFor="code">Code</label>
        <input id="code" name="code" inputMode="numeric" autoComplete="one-time-code" pattern="[0-9 ]{6,7}" required />
        <button className="btn block mt" type="submit">Continue</button>
      </form>
      {!config.isProduction && <p className="small">Development tip: the current code is shown in the server log.</p>}
    </div>
  );
}
