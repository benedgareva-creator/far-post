import { redirect } from "next/navigation";
import { requireAdmin } from "@/lib/auth";
import { now as gameNow } from "@/lib/clock";
import { one, q } from "@/lib/db";
import { previewRules, publishDraftRules, saveDraftRules } from "@/lib/services/admin";
import { DEFAULT_RULES, MEASURE_LABELS, parseRules, type MeasureKey, type ScoringRules } from "@/lib/scoring/rules";
import { GameError } from "@/lib/services/teams";
import { AdminNav } from "@/components/AdminNav";
import type { Position } from "@/lib/game/rules";

export const dynamic = "force-dynamic";
const POS: Position[] = ["GK", "DEF", "MID", "FWD"];
const KEYS = Object.keys(MEASURE_LABELS) as MeasureKey[];
const THRESHOLDS: Partial<Record<MeasureKey, [string, string][]>> = {
  minutes: [["threshold", "Long-appearance minutes"], ["shortPoints", "Points for 1 to (threshold−1) minutes"], ["longPoints", "Points for threshold+ minutes"]],
  cleanSheet: [["minMinutes", "Minimum minutes"]],
  conceded: [["per", "Per this many goals"], ["minMinutes", "Minimum minutes"]],
  saves: [["per", "Per this many saves"]],
};

function readForm(f: FormData): ScoringRules {
  const r = structuredClone(DEFAULT_RULES) as unknown as Record<string, Record<string, unknown>>;
  for (const k of KEYS) {
    const m = r[k];
    m.enabled = f.get(`${k}.enabled`) === "on";
    m.eligible = POS.filter((p) => f.get(`${k}.eligible.${p}`) === "on");
    if (k !== "minutes") m.points = Object.fromEntries(POS.map((p) => [p, Math.trunc(Number(f.get(`${k}.points.${p}`) || 0))]));
    for (const [field] of THRESHOLDS[k] ?? []) m[field] = Math.trunc(Number(f.get(`${k}.${field}`) || 0));
    if (k === "red") m.replacesYellow = f.get("red.replacesYellow") === "on";
  }
  return parseRules(r);
}

async function act(formData: FormData) {
  "use server";
  const admin = await requireAdmin();
  const what = String(formData.get("what"));
  let msg = "";
  try {
    const rules = readForm(formData);
    await saveDraftRules(admin.id, String(formData.get("name") || "Edited rules"), rules);
    if (what === "publish") msg = `Published. These rules apply from Week ${await publishDraftRules(admin.id, await gameNow())}; earlier Weeks keep their own rules.`;
    else msg = what === "preview" ? "preview" : "Draft saved.";
  } catch (e) {
    msg = e instanceof GameError ? e.message : `Could not save: ${(e as Error).message}`;
  }
  redirect(`/admin/scoring?m=${encodeURIComponent(msg)}`);
}

export default async function Scoring({ searchParams }: { searchParams: Promise<{ m?: string }> }) {
  await requireAdmin();
  const now = await gameNow();
  const sp = await searchParams;
  const draft = await one<{ id: number; name: string; config: unknown }>("SELECT id, name, config FROM rulesets WHERE status = 'draft' ORDER BY id DESC LIMIT 1");
  const live = await one<{ id: number; name: string; config: unknown; from_week: number }>("SELECT id, name, config, from_week FROM rulesets WHERE status = 'published' ORDER BY id DESC LIMIT 1");
  const rules = parseRules(draft?.config ?? live?.config ?? DEFAULT_RULES);
  const history = await q<{ id: number; name: string; from_week: number; published_at: Date }>("SELECT id, name, from_week, published_at FROM rulesets WHERE status = 'published' ORDER BY id DESC");
  const preview = sp.m === "preview" ? await previewRules(rules, now) : null;
  const R = rules as unknown as Record<string, Record<string, unknown>>;
  return (
    <>
      <AdminNav active="/admin/scoring" />
      <p className="small">Edit points, thresholds and which positions score. Preview shows how last Week would have scored. Publishing applies to the next Week whose deadline has not passed; past Weeks never change.</p>
      {sp.m && sp.m !== "preview" && <div className="notice ok">{sp.m}</div>}
      {preview && (
        <div className="card">
          <div style={{ fontWeight: 700 }}>Preview: Week {preview.week} with these rules</div>
          <div className="small">{preview.changedCount} player scores would change.</div>
          <table className="table mt"><thead><tr><th>Team</th><th>Now</th><th>With draft</th></tr></thead>
            <tbody>{preview.teams.map((t) => <tr key={t.team}><td>{t.team}</td><td className="num">{t.now}</td><td className="num">{t.draft}{t.draft !== t.now ? ` (${t.draft > t.now ? "+" : ""}${t.draft - t.now})` : ""}</td></tr>)}</tbody>
          </table>
        </div>
      )}
      <form action={act} className="stack mt">
        <div className="card">
          <label htmlFor="name" style={{ marginTop: 0 }}>Name for this rule set</label>
          <input id="name" name="name" defaultValue={draft?.name ?? "Edited rules"} />
        </div>
        {KEYS.map((k) => {
          const m = R[k];
          return (
            <div className="card" key={k}>
              <div className="spread">
                <strong>{MEASURE_LABELS[k]}</strong>
                <label style={{ margin: 0, display: "flex", gap: 6, alignItems: "center", fontWeight: 400 }}><input type="checkbox" name={`${k}.enabled`} defaultChecked={m.enabled as boolean} /> On</label>
              </div>
              <div className="scroll-x">
                <table className="table">
                  <thead><tr><th></th>{POS.map((p) => <th key={p}>{p}</th>)}</tr></thead>
                  <tbody>
                    <tr><td className="small">Scores</td>{POS.map((p) => <td key={p}><input type="checkbox" name={`${k}.eligible.${p}`} defaultChecked={(m.eligible as string[]).includes(p)} aria-label={`${MEASURE_LABELS[k]} counts for ${p}`} /></td>)}</tr>
                    {k !== "minutes" && <tr><td className="small">Points</td>{POS.map((p) => <td key={p}><input className="tiny" type="number" name={`${k}.points.${p}`} defaultValue={(m.points as Record<string, number>)[p]} aria-label={`${MEASURE_LABELS[k]} points for ${p}`} /></td>)}</tr>}
                  </tbody>
                </table>
              </div>
              {(THRESHOLDS[k] ?? []).map(([field, label]) => (
                <div className="spread" key={field} style={{ marginTop: 8 }}><span className="small">{label}</span><input className="tiny" type="number" name={`${k}.${field}`} defaultValue={m[field] as number} aria-label={label} /></div>
              ))}
              {k === "red" && <label style={{ display: "flex", gap: 8, fontWeight: 400 }}><input type="checkbox" name="red.replacesYellow" defaultChecked={m.replacesYellow as boolean} /> A sending-off replaces the yellow card</label>}
            </div>
          );
        })}
        <div className="grid2" style={{ position: "sticky", bottom: 84 }}>
          <button className="btn secondary" name="what" value="preview" type="submit">Save and preview</button>
          <button className="btn" name="what" value="publish" type="submit">Publish for next Week</button>
        </div>
      </form>
      <h2>Published rule sets</h2>
      <div className="list">
        {history.map((h) => <div className="row" key={h.id}><div className="grow"><div className="title">{h.name}</div><div className="meta">From Week {h.from_week ?? 1}</div></div></div>)}
      </div>
      <p className="small">New kinds of measure (for example tackles) need builder work. Any measure can be switched off.</p>
    </>
  );
}
