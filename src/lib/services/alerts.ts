// Alerts for Ben: shown on Admin > Health and emailed straight away.
import { config } from "../config";
import { one, q, type Db, pool } from "../db";
import { sendEmail } from "../email";

export type AlertLevel = "info" | "warning" | "critical";

export const MAX_ALERT_EMAIL_ATTEMPTS = 5;

/**
 * Raises an alert unless the same kind is already open. Emails warnings and critical alerts
 * immediately; if that email fails, it is retried (by the poller and on the next raise) up to five times.
 */
export async function raiseAlert(kind: string, level: AlertLevel, message: string, db: Db = pool()): Promise<boolean> {
  const open = await one<{ id: number; emailed: boolean; email_attempts: number; level: AlertLevel }>(
    "SELECT id, emailed, email_attempts, level FROM alerts WHERE kind = $1 AND resolved_at IS NULL",
    [kind],
    db,
  );
  if (open) {
    if (open.level !== "info" && !open.emailed && open.email_attempts < MAX_ALERT_EMAIL_ATTEMPTS) await emailAlert(open.id, db);
    return false;
  }
  const row = await one<{ id: number }>("INSERT INTO alerts (level, kind, message) VALUES ($1,$2,$3) RETURNING id", [level, kind, message], db);
  if (level !== "info") await emailAlert(row!.id, db);
  return true;
}

async function emailAlert(id: number, db: Db) {
  const a = await one<{ message: string }>("UPDATE alerts SET email_attempts = email_attempts + 1 WHERE id = $1 RETURNING message", [id], db);
  if (!a) return;
  const res = await sendEmail({ to: config.alertEmails, subject: `Far Post alert: ${a.message.slice(0, 80)}`, text: `${a.message}\n\nOpen Admin > Health: ${config.appUrl}/admin` }, "alert", db);
  if (res.ok) await q("UPDATE alerts SET emailed = true WHERE id = $1", [id], db);
}

/** Tries again to email open warnings and critical alerts whose email failed. */
export async function retryAlertEmails(db: Db = pool()) {
  const rows = await q<{ id: number }>(
    "SELECT id FROM alerts WHERE resolved_at IS NULL AND level <> 'info' AND NOT emailed AND email_attempts < $1",
    [MAX_ALERT_EMAIL_ATTEMPTS],
    db,
  );
  for (const r of rows) await emailAlert(r.id, db);
}

export async function resolveAlert(kind: string, db: Db = pool()) {
  await q("UPDATE alerts SET resolved_at = now() WHERE kind = $1 AND resolved_at IS NULL", [kind], db);
}

export async function openAlerts(db: Db = pool()) {
  return q<{ id: number; at: Date; level: AlertLevel; kind: string; message: string; emailed: boolean }>(
    "SELECT id, at, level, kind, message, emailed FROM alerts WHERE resolved_at IS NULL ORDER BY at DESC",
    [],
    db,
  );
}

export async function logAdmin(userId: number | null, action: string, details: unknown, db: Db = pool()) {
  await q("INSERT INTO admin_log (user_id, action, details) VALUES ($1,$2,$3)", [userId, action, JSON.stringify(details ?? {})], db);
}
