// Sends email through Resend (https://resend.com). Without RESEND_API_KEY the
// message is printed to the server log instead, which is fine for trying things out.
import { config } from "../config";

export interface Email {
  to: string | string[];
  subject: string;
  text: string;
}

export async function sendEmail(msg: Email): Promise<{ ok: boolean; error?: string }> {
  const to = Array.isArray(msg.to) ? msg.to : [msg.to];
  if (to.length === 0) return { ok: false, error: "No recipient" };
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
