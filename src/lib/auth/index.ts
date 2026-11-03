// Sign-in by emailed link, long sessions, limited attempts, admin two-step sign-in.
import { cookies, headers } from "next/headers";
import { redirect } from "next/navigation";
import { config } from "../config";
import { one, q, tx } from "../db";
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

/** May this email sign in? Existing players, admins and invited emails only: the game is invite-only. */
async function mayEnter(email: string, db?: Parameters<typeof one>[2]): Promise<boolean> {
  if (config.adminEmails.includes(email)) return true;
  return !!(await one("SELECT 1 FROM users WHERE email = $1 UNION ALL SELECT 1 FROM invites WHERE email = $1 LIMIT 1", [email], db));
}

/** Emails a sign-in link to an invited email. Attempts are limited per email and per address. */
export async function requestLoginLink(rawEmail: string, ip: string): Promise<{ ok: boolean; message: string }> {
  const email = rawEmail.trim().toLowerCase();
  if (!validEmail(email)) return { ok: false, message: "Please enter a valid email address." };
  if (!(await mayEnter(email))) {
    return { ok: false, message: "Far Post is invite-only, and this email has not been invited yet. Ask the person running your game to invite you." };
  }
  const token = randomToken();
  // Count and record the attempt under locks on this email and this address, so many requests at
  // once cannot all slip under the limit.
  const allowed = await tx(async (c) => {
    await q("SELECT pg_advisory_xact_lock(hashtext('login-email:' || $1)), pg_advisory_xact_lock(hashtext('login-ip:' || $2))", [email, ip], c);
    const perEmail = await one<{ n: string }>("SELECT count(*) AS n FROM login_tokens WHERE email = $1 AND created_at > now() - interval '1 hour'", [email], c);
    const perIp = await one<{ n: string }>("SELECT count(*) AS n FROM login_tokens WHERE ip = $1 AND created_at > now() - interval '1 hour'", [ip], c);
    if (Number(perEmail?.n) >= MAX_LINKS_PER_EMAIL_HOUR || Number(perIp?.n) >= MAX_LINKS_PER_IP_HOUR) return false;
    await q("INSERT INTO login_tokens (email, token_hash, expires_at, ip) VALUES ($1, $2, now() + make_interval(mins => $3), $4)", [email, sha256(token), LINK_MINUTES, ip], c);
    return true;
  });
  if (!allowed) return { ok: false, message: "Too many sign-in attempts. Please wait an hour and try again." };
  const link = `${config.appUrl}/auth/verify?token=${token}`;
  const sent = await sendEmail({
    to: email,
    subject: "Your Far Post sign-in link",
    text: `Tap to sign in to Far Post:\n\n${link}\n\nThe link works once and expires in ${LINK_MINUTES} minutes. If you did not ask for it, ignore this email.`,
  }, "login");
  if (!sent.ok) {
    await q("DELETE FROM login_tokens WHERE token_hash = $1", [sha256(token)]);
    return { ok: false, message: sent.error === "Email allowance used up" ? "Far Post has sent its maximum number of emails for today. Please try again tomorrow." : "We could not send the email just now. Please try again shortly." };
  }
  return { ok: true, message: "Check your email for a sign-in link." };
}

/** Uses up a sign-in link and starts a session. Returns null if the link is invalid, used, expired or not invited. */
export async function consumeLoginLink(token: string): Promise<number | null> {
  const row = await one<{ id: number; email: string }>(
    "UPDATE login_tokens SET used_at = now() WHERE token_hash = $1 AND used_at IS NULL AND expires_at > now() RETURNING id, email",
    [sha256(token)],
  );
  if (!row) return null;
  if (!(await mayEnter(row.email))) return null; // invitation withdrawn since the link was sent
  const isAdmin = config.adminEmails.includes(row.email);
  const user = await one<{ id: number }>(
    `INSERT INTO users (email, is_admin) VALUES ($1, $2)
     ON CONFLICT (email) DO UPDATE SET is_admin = users.is_admin OR EXCLUDED.is_admin RETURNING id`,
    [row.email, isAdmin],
  );
  await q("UPDATE invites SET used_at = COALESCE(used_at, now()) WHERE email = $1", [row.email]);
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

/** Ben invites people by email. Each new invitee gets an email telling them how to sign in. */
export async function inviteEmails(adminId: number, raw: string): Promise<{ invited: string[]; skipped: string[]; notEmailed: string[] }> {
  const emails = [...new Set(raw.split(/[\s,;]+/).map((e) => e.trim().toLowerCase()).filter(Boolean))];
  const invited: string[] = [], skipped: string[] = [], notEmailed: string[] = [];
  for (const email of emails) {
    if (!validEmail(email)) { skipped.push(email); continue; }
    const row = await one("INSERT INTO invites (email, invited_by) VALUES ($1, $2) ON CONFLICT DO NOTHING RETURNING email", [email, adminId]);
    if (!row) { skipped.push(email); continue; }
    invited.push(email);
    const sent = await sendEmail({
      to: email,
      subject: "You're invited to Far Post",
      text: `You've been invited to play Far Post, a private fantasy football game.\n\nSign in with this email address at ${config.appUrl}/login and we'll send you a link. No password needed.`,
    }, "invite");
    if (!sent.ok) notEmailed.push(email);
  }
  return { invited, skipped, notEmailed };
}

export async function withdrawInvite(email: string) {
  await q("DELETE FROM invites WHERE email = $1 AND used_at IS NULL", [email.trim().toLowerCase()]);
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
