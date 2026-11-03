// Sends email through Resend (https://resend.com). Without RESEND_API_KEY the
// message is printed to the server log instead, which is fine for trying things out.
//
// Every send is counted against the service's shared daily and monthly allowance. Sign-in links
// and invitations stop a little before the limit, keeping the last few emails for Ben's alerts.
import { config } from "../config";
import { one, q, type Db, pool } from "../db";

export interface Email {
  to: string | string[];
  subject: string;
  text: string;
}

export type EmailKind = "login" | "invite" | "alert";

/** Emails kept back for alerts at the end of each day and month. */
export const ALERT_RESERVE_DAY = 10;
export const ALERT_RESERVE_MONTH = 30;

export async function emailUsage(db: Db = pool()): Promise<{ today: number; month: number }> {
  const r = await one<{ today: string; month: string }>(
    `SELECT count(*) FILTER (WHERE at >= date_trunc('day', now() AT TIME ZONE 'UTC') AT TIME ZONE 'UTC') AS today,
            count(*) AS month
       FROM email_log WHERE ok AND at >= date_trunc('month', now() AT TIME ZONE 'UTC') AT TIME ZONE 'UTC'`,
    [],
    db,
  );
  return { today: Number(r?.today ?? 0), month: Number(r?.month ?? 0) };
}

/** Whether an email of this kind may be sent now without breaking the allowance or the alert reserve. */
export async function emailAllowed(kind: EmailKind, recipients = 1, db: Db = pool()): Promise<boolean> {
  const u = await emailUsage(db);
  const reserveDay = kind === "alert" ? 0 : ALERT_RESERVE_DAY;
  const reserveMonth = kind === "alert" ? 0 : ALERT_RESERVE_MONTH;
  return u.today + recipients <= config.emailDayLimit - reserveDay && u.month + recipients <= config.emailMonthLimit - reserveMonth;
}

export async function sendEmail(msg: Email, kind: EmailKind = "login", db: Db = pool()): Promise<{ ok: boolean; error?: string }> {
  const to = Array.isArray(msg.to) ? msg.to : [msg.to];
  if (to.length === 0) return { ok: false, error: "No recipient" };
  if (!(await emailAllowed(kind, to.length, db))) return { ok: false, error: "Email allowance used up" };
  const res = await deliver(to, msg);
  // Resend counts each recipient as one email.
  for (let i = 0; i < to.length; i++) await q("INSERT INTO email_log (kind, ok, error) VALUES ($1, $2, $3)", [kind, res.ok, res.error ?? null], db);
  return res;
}

async function deliver(to: string[], msg: Email): Promise<{ ok: boolean; error?: string }> {
  if (!config.resendKey) {
    console.log(`\n[email not sent: RESEND_API_KEY empty]\nTo: ${to.join(", ")}\nSubject: ${msg.subject}\n\n${msg.text}\n`);
    return { ok: true };
  }
  try {
    const res = await fetch("https://api.resend.com/emails", {
      method: "POST",
      headers: { Authorization: `Bearer ${config.resendKey}`, "Content-Type": "application/json" },
      body: JSON.stringify({ from: config.emailFrom, to, subject: msg.subject, text: msg.text }),
      signal: AbortSignal.timeout(15_000),
    });
    if (!res.ok) return { ok: false, error: `Resend replied ${res.status}: ${await res.text()}` };
    return { ok: true };
  } catch (e) {
    return { ok: false, error: (e as Error).message };
  }
}
