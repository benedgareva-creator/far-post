// Alerts for Ben: shown on Admin > Health and emailed straight away.
import { config } from "../config";
import { one, q, type Db, pool } from "../db";
import { sendEmail } from "../email";

export type AlertLevel = "info" | "warning" | "critical";

/** Raises an alert unless the same kind is already open. Emails warnings and critical alerts immediately. */
export async function raiseAlert(kind: string, level: AlertLevel, message: string, db: Db = pool()): Promise<boolean> {
  const open = await one("SELECT 1 FROM alerts WHERE kind = $1 AND resolved_at IS NULL", [kind], db);
  if (open) return false;
  const row = await one<{ id: number }>("INSERT INTO alerts (level, kind, message) VALUES ($1,$2,$3) RETURNING id", [level, kind, message], db);
  if (level !== "info") {
    const res = await sendEmail({ to: config.alertEmails, subject: `Far Post alert: ${message.slice(0, 80)}`, text: `${message}\n\nOpen Admin > Health: ${config.appUrl}/admin` });
    if (res.ok) await q("UPDATE alerts SET emailed = true WHERE id = $1", [row!.id], db);
  }
  return true;
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
