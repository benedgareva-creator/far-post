import { redirect } from "next/navigation";
import { requireAdmin } from "@/lib/auth";
import { now as gameNow } from "@/lib/clock";
import { config, PLAN_LIMITS } from "@/lib/config";
import { getSetting, one, q, setSetting } from "@/lib/db";
import { logAdmin, openAlerts, resolveAlert } from "@/lib/services/alerts";
import { pacing, expectedDailyCalls } from "@/poller/budget";
import { AdminNav } from "@/components/AdminNav";
import { ago, fmtDate } from "@/components/StatusPill";
import { AutoRefresh } from "@/components/AutoRefresh";

export const dynamic = "force-dynamic";

async function action(formData: FormData) {
  "use server";
  const admin = await requireAdmin();
  const what = String(formData.get("what"));
  if (what === "pause") await setSetting("poller_paused", true);
  if (what === "resume") await setSetting("poller_paused", false);
  if (what === "unblock") {
    await q("DELETE FROM settings WHERE key = 'poller_blocked'");
    await resolveAlert("blocked");
  }
  if (what === "expiry") await setSetting("api_expiry_manual", String(formData.get("date") || "") || null);
  if (what === "resolve") await q("UPDATE alerts SET resolved_at = now() WHERE id = $1", [Number(formData.get("id"))]);
  if (what === "fault" && config.provider === "mock") await setSetting("mock_fault", String(formData.get("fault")) || null);
  if (what === "clock" && config.provider === "mock") {
    const cur = (await getSetting<number>("mock_clock_offset_ms")) ?? 0;
    await setSetting("mock_clock_offset_ms", cur + Number(formData.get("minutes")) * 60_000);
  }
  await logAdmin(admin.id, `health: ${what}`, Object.fromEntries(formData.entries()));
  redirect("/admin");
}

export default async function Health() {
  await requireAdmin();
  const now = await gameNow();
  const day = now.toISOString().slice(0, 10);
  const limits = PLAN_LIMITS[config.apiFootball.plan];
  const used = await one<{ n: string; live: string; bg: string; corr: string; failed: string }>(
    `SELECT count(*) AS n, count(*) FILTER (WHERE purpose = 'live') AS live, count(*) FILTER (WHERE purpose = 'background') AS bg,
            count(*) FILTER (WHERE purpose = 'correction') AS corr, count(*) FILTER (WHERE NOT ok) AS failed
       FROM api_requests WHERE utc_day = $1`,
    [day],
  );
  const lastReq = await one<{ day_limit: number | null; day_remaining: number | null; minute_limit: number | null; minute_remaining: number | null; at: Date; error: string | null }>(
    "SELECT day_limit, day_remaining, minute_limit, minute_remaining, at, error FROM api_requests ORDER BY id DESC LIMIT 1",
  );
  const dayLimit = lastReq?.day_limit ?? limits.day;
  const usedToday = Math.max(Number(used?.n ?? 0), lastReq?.day_limit && lastReq.day_remaining != null ? lastReq.day_limit - lastReq.day_remaining : 0);
  const p = pacing({ dayLimit, minuteLimit: lastReq?.minute_limit ?? limits.minute, usedToday });
  const heartbeat = await getSetting<string>("poller_heartbeat");
  const lastSuccess = await getSetting<string>("last_success");
  const paused = (await getSetting<boolean>("poller_paused")) === true;
  const blocked = await getSetting<{ at: string; error: string }>("poller_blocked");
  const status = await getSetting<{ plan: string | null; expires: string | null; active: boolean | null; checkedAt: string }>("api_status");
  const manualExpiry = await getSetting<string>("api_expiry_manual");
  const fault = await getSetting<string>("mock_fault");
  const alerts = await openAlerts();
  const pollerAlive = heartbeat && now.getTime() - new Date(heartbeat).getTime() < 60_000;
  const normal = expectedDailyCalls({ activeMinutes: 630, matchMinutes: 1800, batch: true });
  const fallback = expectedDailyCalls({ activeMinutes: 630, matchMinutes: 1800, batch: false });
  const Btn = ({ what, label, cls = "secondary", extra }: { what: string; label: string; cls?: string; extra?: Record<string, string> }) => (
    <form action={action} style={{ display: "inline" }}>
      <input type="hidden" name="what" value={what} />
      {extra && Object.entries(extra).map(([k, v]) => <input key={k} type="hidden" name={k} value={v} />)}
      <button className={`btn small ${cls}`} type="submit">{label}</button>
    </form>
  );
  return (
    <>
      <AutoRefresh />
      <AdminNav active="/admin" />
      {config.provider === "mock" && <div className="notice warn">Demo mode: made-up league and players. Set FOOTBALL_PROVIDER=api-football and API_FOOTBALL_KEY to use real data.</div>}
      {alerts.length > 0 && (
        <>
          <h2>Alerts</h2>
          <div className="list">
            {alerts.map((a) => (
              <div className="row" key={a.id}>
                <span className={`pill ${a.level === "critical" ? "live" : a.level === "warning" ? "warn" : ""}`}>{a.level}</span>
                <div className="grow"><div style={{ fontWeight: 600 }}>{a.message}</div><div className="meta">{ago(a.at, now)}{a.emailed ? " · emailed" : ""}</div></div>
                <Btn what="resolve" label="Dismiss" extra={{ id: String(a.id) }} />
              </div>
            ))}
          </div>
        </>
      )}
      <h2>Live updates</h2>
      <div className="card stack">
        <div className="spread"><span>Poller</span><span className={`pill ${pollerAlive ? "final" : "live"}`}>{pollerAlive ? "Running" : "Not running"}</span></div>
        <div className="spread"><span>Last heartbeat</span><span className="num">{ago(heartbeat, now)}</span></div>
        <div className="spread"><span>Last successful fetch</span><span className="num">{ago(lastSuccess, now)}</span></div>
        <div className="spread"><span>Mode</span><span className="num">{blocked ? "Blocked" : paused ? "Paused" : p.mode === "normal" ? "Every 60 s" : p.mode === "slow" ? "Every 2 min (80% used)" : p.mode === "slower" ? "Every 5 min (90% used)" : "Live stopped (95% used)"}</span></div>
        {blocked && <div className="notice error">Supplier refused requests: {blocked.error}. Contact API-Football support, then press Resume.</div>}
        <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
          {paused ? <Btn what="resume" label="Resume" cls="" /> : <Btn what="pause" label="Pause live updates" />}
          {blocked && <Btn what="unblock" label="Clear block and resume" cls="" />}
        </div>
      </div>
      <h2>Requests today (UTC)</h2>
      <div className="card stack">
        <div className="spread"><span>Used</span><span className="num">{usedToday} / {dayLimit} ({Math.round((usedToday / dayLimit) * 100)}%)</span></div>
        <div style={{ height: 8, borderRadius: 4, background: "var(--surface-2)", overflow: "hidden" }}><div style={{ width: `${Math.min(100, (usedToday / dayLimit) * 100)}%`, height: "100%", background: usedToday / dayLimit >= 0.8 ? "var(--live)" : "var(--accent)" }} /></div>
        <div className="small">Live {used?.live} · background {used?.bg} · corrections {used?.corr} · failed {used?.failed}. Minute allowance {lastReq?.minute_limit ?? limits.minute}; calls spaced at least {p.minGapMs / 1000}s apart.</div>
        <div className="small">A busy Saturday needs about {normal} calls ({Math.round((normal / dayLimit) * 100)}% of this plan), or {fallback} ({Math.round((fallback / dayLimit) * 100)}%) in per-match fallback mode.</div>
      </div>
      <h2>Data plan</h2>
      <div className="card stack">
        <div className="spread"><span>Supplier</span><span>{config.provider === "mock" ? "Demo data" : "API-Football (direct)"}</span></div>
        <div className="spread"><span>Plan</span><span>{status?.plan ?? config.apiFootball.plan}</span></div>
        <div className="spread"><span>Ends</span><span>{status?.expires ? fmtDate(status.expires, { day: "numeric", month: "short", year: "numeric" }) : manualExpiry ? `${fmtDate(manualExpiry, { day: "numeric", month: "short", year: "numeric" })} (typed in)` : "Unknown"}</span></div>
        <div className="small">Checked {ago(status?.checkedAt ?? null, now)}. You get an alert seven days before the end date.</div>
        <form action={action} style={{ display: "flex", gap: 8 }}>
          <input type="hidden" name="what" value="expiry" />
          <input type="date" name="date" defaultValue={manualExpiry?.slice(0, 10) ?? ""} aria-label="Plan end date" />
          <button className="btn small secondary" type="submit">Save end date</button>
        </form>
      </div>
      <h2>Backups</h2>
      <div className="card stack">
        <p className="small" style={{ margin: 0 }}>Download a copy every week and keep it somewhere safe (e.g. iCloud Drive). Render also keeps its own recent copies.</p>
        <a className="btn secondary" href="/api/admin/backup">Download backup</a>
      </div>
      {config.provider === "mock" && (
        <>
          <h2>Demo tools</h2>
          <div className="card stack">
            <div className="small">Simulate supplier problems to see how the game reacts{fault ? ` (now: ${fault})` : ""}.</div>
            <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
              <Btn what="fault" label="Too many requests" extra={{ fault: "rate" }} />
              <Btn what="fault" label="Blocked" extra={{ fault: "block" }} />
              <Btn what="fault" label="Daily limit" extra={{ fault: "day" }} />
              <Btn what="fault" label="No fault" extra={{ fault: "" }} />
            </div>
            <div className="small">Move the demo clock (the made-up matches play in real time).</div>
            <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
              <Btn what="clock" label="+15 min" extra={{ minutes: "15" }} />
              <Btn what="clock" label="+1 hour" extra={{ minutes: "60" }} />
              <Btn what="clock" label="+1 day" extra={{ minutes: "1440" }} />
            </div>
          </div>
        </>
      )}
    </>
  );
}
