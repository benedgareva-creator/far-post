export function StatusPill({ status, partial }: { status: string; partial?: boolean }) {
  if (status === "live") return <span className="pill live">{partial === false ? "Live" : "Partial live points"}</span>;
  if (status === "provisional") return <span className="pill">{partial ? "Provisional · pending data" : "Provisional"}</span>;
  if (status === "final") return <span className="pill final">Final</span>;
  return <span className="pill">{status}</span>;
}

export function ago(d: Date | string | null, now: Date): string {
  if (!d) return "never";
  const s = Math.max(0, Math.round((now.getTime() - new Date(d).getTime()) / 1000));
  if (s < 60) return `${s}s ago`;
  if (s < 3600) return `${Math.floor(s / 60)} min ago`;
  if (s < 86400) return `${Math.floor(s / 3600)} h ago`;
  return `${Math.floor(s / 86400)} days ago`;
}

/**
 * Dates and times are shown in UK time. Whenever a time of day is shown, the zone is named too
 * (GMT or BST), so nobody abroad mistakes a deadline for their own local time.
 */
export function fmtDate(d: Date | string, opts: Intl.DateTimeFormatOptions = { weekday: "short", day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" }) {
  const withZone: Intl.DateTimeFormatOptions = opts.hour !== undefined ? { ...opts, timeZoneName: "short" } : opts;
  return new Intl.DateTimeFormat("en-GB", { ...withZone, timeZone: "Europe/London" }).format(new Date(d));
}
