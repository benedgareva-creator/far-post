// Sign-in by emailed link, long sessions, limited attempts, admin two-step sign-in.
import { cookies, headers } from "next/headers";
import { redirect } from "next/navigation";
import { config } from "../config";
import { one, q } from "../db";
import { sendEmail } from "../email";
import { randomToken, sha256 } from "./crypto";

export const SESSION_COOKIE = "fp_session";
const SESSION_DAYS = 90;
const LINK_MINUTES = 20;
const MAX_LINKS_PER_EMAIL_HOUR = 5;
const MAX_LINKS_PER_IP_HOUR = 20;

export interface CurrentUser {
  id: number;
  email: string;
  team_name: string | null;
  is_admin: boolean;
  joined_week: number | null;
  totp_secret: string | null;
  second_factor: boolean;
}

export async function clientIp(): Promise<string> {
  const h = await headers();
  return (h.get("x-forwarded-for") ?? "").split(",")[0].trim() || "unknown";
}

const validEmail = (e: string) => /^[^\s@]{1,64}@[^\s@]{1,190}\.[^\s@]{2,}$/.test(e) && e.length <= 254;

/** Emails a sign-in link. Always answers the same way so nobody can probe which emails exist. */
export async function requestLoginLink(rawEmail: string, ip: string): Promise<{ ok: boolean; message: string }> {
  const email = rawEmail.trim().toLowerCase();
  if (!validEmail(email)) return { ok: false, message: "Please enter a valid email address." };
  const perEmail = await one<{ n: string }>("SELECT count(*) AS n FROM login_tokens WHERE email = $1 AND created_at > now() - interval '1 hour'", [email]);
  const perIp = await one<{ n: string }>("SELECT count(*) AS n FROM login_tokens WHERE ip = $1 AND created_at > now() - interval '1 hour'", [ip]);
  if (Number(perEmail?.n) >= MAX_LINKS_PER_EMAIL_HOUR || Number(perIp?.n) >= MAX_LINKS_PER_IP_HOUR) {
    return { ok: false, message: "Too many sign-in attempts. Please wait an hour and try again." };
  }
  const token = randomToken();
  await q("INSERT INTO login_tokens (email, token_hash, expires_at, ip) VALUES ($1, $2, now() + make_interval(mins => $3), $4)", [email, sha256(token), LINK_MINUTES, ip]);
  const link = `${config.appUrl}/auth/verify?token=${token}`;
  const sent = await sendEmail({
    to: email,
    subject: "Your Far Post sign-in link",
    text: `Tap to sign in to Far Post:\n\n${link}\n\nThe link works once and expires in ${LINK_MINUTES} minutes. If you did not ask for it, ignore this email.`,
  });
  if (!sent.ok) return { ok: false, message: "We could not send the email just now. Please try again shortly." };
  return { ok: true, message: "Check your email for a sign-in link." };
}

/** Uses up a sign-in link and starts a session. Returns null if the link is invalid, used or expired. */
export async function consumeLoginLink(token: string): Promise<number | null> {
  const row = await one<{ id: number; email: string }>(
    "UPDATE login_tokens SET used_at = now() WHERE token_hash = $1 AND used_at IS NULL AND expires_at > now() RETURNING id, email",
    [sha256(token)],
  );
  if (!row) return null;
  const isAdmin = config.adminEmails.includes(row.email);
  const user = await one<{ id: number }>(
    `INSERT INTO users (email, is_admin) VALUES ($1, $2)
     ON CONFLICT (email) DO UPDATE SET is_admin = users.is_admin OR EXCLUDED.is_admin RETURNING id`,
    [row.email, isAdmin],
  );
  const session = randomToken();
  await q("INSERT INTO sessions (user_id, token_hash, expires_at) VALUES ($1, $2, now() + make_interval(days => $3))", [user!.id, sha256(session), SESSION_DAYS]);
  (await cookies()).set(SESSION_COOKIE, session, {
    httpOnly: true,
    secure: config.isProduction,
    sameSite: "lax",
    path: "/",
    maxAge: SESSION_DAYS * 86400,
  });
  return user!.id;
}

export async function currentUser(): Promise<CurrentUser | null> {
  const token = (await cookies()).get(SESSION_COOKIE)?.value;
  if (!token) return null;
  return one<CurrentUser>(
    `SELECT u.id, u.email, u.team_name, u.is_admin, u.joined_week, u.totp_secret, s.second_factor
       FROM sessions s JOIN users u ON u.id = s.user_id
      WHERE s.token_hash = $1 AND s.expires_at > now()`,
    [sha256(token)],
  );
}

export async function requireUser(): Promise<CurrentUser> {
  const u = await currentUser();
  if (!u) redirect("/login");
  return u;
}

/** Admin pages need an admin account that has passed two-step sign-in in this session. */
export async function requireAdmin(): Promise<CurrentUser> {
  const u = await requireUser();
  if (!u.is_admin) redirect("/");
  if (!u.second_factor) redirect("/admin/two-step");
  return u;
}

export async function markSecondFactor() {
  const token = (await cookies()).get(SESSION_COOKIE)?.value;
  if (token) await q("UPDATE sessions SET second_factor = true WHERE token_hash = $1", [sha256(token)]);
}

export async function signOut() {
  const jar = await cookies();
  const token = jar.get(SESSION_COOKIE)?.value;
  if (token) await q("DELETE FROM sessions WHERE token_hash = $1", [sha256(token)]);
  jar.delete(SESSION_COOKIE);
}
