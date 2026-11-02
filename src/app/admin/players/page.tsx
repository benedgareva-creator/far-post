import { redirect } from "next/navigation";
import { requireAdmin } from "@/lib/auth";
import { getSetting, q, setSetting } from "@/lib/db";
import { approvePlayer, publishPrices, refreshSuggestions, setPlayerPrice } from "@/lib/services/admin";
import { logAdmin } from "@/lib/services/alerts";
import { GameError } from "@/lib/services/teams";
import { AdminNav } from "@/components/AdminNav";
import type { Position } from "@/lib/game/rules";

export const dynamic = "force-dynamic";
const POS: Position[] = ["GK", "DEF", "MID", "FWD"];

async function act(formData: FormData) {
  "use server";
  const admin = await requireAdmin();
  const what = String(formData.get("what"));
  const back = String(formData.get("back") ?? "/admin/players");
  let m = "";
  try {
    if (what === "fetch") {
      await setSetting("job_refresh_stats", true);
      await logAdmin(admin.id, "request season numbers", {});
      m = "Requested. The poller will fetch season numbers and refresh suggestions within a minute.";
    }
    if (what === "suggest") {
      await refreshSuggestions();
      m = "Suggestions refreshed.";
    }
    if (what === "price") await setPlayerPrice(admin.id, Number(formData.get("id")), Number(formData.get("price")), (formData.get("position") as Position) || undefined);
    if (what === "publish") {
      if (formData.get("confirm") !== "on") throw new GameError("Tick the box to confirm. Prices and positions cannot change after publishing.");
      await publishPrices(admin.id);
      m = "Prices published. They are now fixed for the season.";
    }
    if (what === "approve") {
      await approvePlayer(admin.id, Number(formData.get("id")), Number(formData.get("price")));
      m = "Player added.";
    }
  } catch (e) {
    m = e instanceof GameError ? e.message : (e as Error).message;
  }
  redirect(`${back}${back.includes("?") ? "&" : "?"}m=${encodeURIComponent(m)}`);
}

export default async function Players({ searchParams }: { searchParams: Promise<{ pos?: string; m?: string }> }) {
  await requireAdmin();
  const sp = await searchParams;
  const pos = POS.includes(sp.pos as Position) ? (sp.pos as Position) : "FWD";
  const published = (await getSetting<boolean>("prices_published")) === true;
  const players = await q<{ id: number; name: string; club: string; position: Position; price: number | null; suggested_price: number | null; suggestion_note: string | null; season_goals: number | null; season_assists: number | null; season_minutes: number | null }>(
    `SELECT p.id, p.name, c.short_name AS club, p.position, p.price, p.suggested_price, p.suggestion_note, p.season_goals, p.season_assists, p.season_minutes
       FROM players p JOIN clubs c ON c.id = p.club_id WHERE p.approved AND p.position = $1 ORDER BY COALESCE(p.price, p.suggested_price, 0) DESC, p.name`,
    [pos],
  );
  const waiting = await q<{ id: number; name: string; club: string; position: Position }>("SELECT p.id, p.name, c.short_name AS club, p.position FROM players p JOIN clubs c ON c.id = p.club_id WHERE NOT p.approved ORDER BY p.id");
  const back = `/admin/players?pos=${pos}`;
  const counts = await q<{ price: number; n: string }>("SELECT COALESCE(price, suggested_price) AS price, count(*) AS n FROM players WHERE approved AND position = $1 GROUP BY 1 ORDER BY 1 DESC", [pos]);
  return (
    <>
      <AdminNav active="/admin/players" />
      {sp.m && <div className="notice ok">{sp.m}</div>}
      {published ? (
        <div className="notice">Prices are published and fixed for the season. New players arrive below for approval.</div>
      ) : (
        <div className="card stack">
          <div className="small">Suggested prices come from this season: goal points × goals + 4 × assists + minutes ÷ 90, ranked within each position (top 5% = 10, next 15% = 8, next 30% = 6, rest = 4; missing records = 6). Review, adjust, then publish.</div>
          <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
            <form action={act}><input type="hidden" name="what" value="fetch" /><input type="hidden" name="back" value={back} /><button className="btn small secondary">Fetch season numbers</button></form>
            <form action={act}><input type="hidden" name="what" value="suggest" /><input type="hidden" name="back" value={back} /><button className="btn small secondary">Recalculate suggestions</button></form>
          </div>
          <form action={act} style={{ display: "flex", gap: 10, alignItems: "center", flexWrap: "wrap" }}>
            <input type="hidden" name="what" value="publish" /><input type="hidden" name="back" value={back} />
            <label style={{ margin: 0, display: "flex", gap: 8, fontWeight: 400 }}><input type="checkbox" name="confirm" /> I have reviewed all four positions</label>
            <button className="btn small">Publish prices</button>
          </form>
        </div>
      )}
      {waiting.length > 0 && (
        <>
          <h2>Waiting for approval ({waiting.length})</h2>
          <div className="list">
            {waiting.map((p) => (
              <form action={act} className="row" key={p.id}>
                <input type="hidden" name="what" value="approve" /><input type="hidden" name="id" value={p.id} /><input type="hidden" name="back" value={back} />
                <span className="pos">{p.position}</span>
                <div className="grow"><div className="title">{p.name}</div><div className="meta">{p.club}</div></div>
                <select className="tiny" name="price" defaultValue="6" aria-label="Price">{[4, 6, 8, 10].map((v) => <option key={v}>{v}</option>)}</select>
                <button className="btn small">Add</button>
              </form>
            ))}
          </div>
        </>
      )}
      <h2>Prices</h2>
      <div className="seg">{POS.map((p) => <a key={p} className={`chip${p === pos ? " on" : ""}`} href={`/admin/players?pos=${p}`}>{p}</a>)}</div>
      <p className="small">{counts.map((c) => `${c.n} at ${c.price ?? "?"}`).join(" · ")}</p>
      <div className="card scroll-x">
        <table className="table">
          <thead><tr><th>Player</th><th>G</th><th>A</th><th>Min</th><th>Suggested</th><th>Price</th></tr></thead>
          <tbody>
            {players.map((p) => (
              <tr key={p.id}>
                <td><div style={{ fontWeight: 600 }}>{p.name}</div><div className="small">{p.club}{p.suggestion_note?.startsWith("Missing") ? " · incomplete record" : ""}</div></td>
                <td className="num">{p.season_goals ?? "–"}</td>
                <td className="num">{p.season_assists ?? "–"}</td>
                <td className="num">{p.season_minutes ?? "–"}</td>
                <td className="num">{p.suggested_price ?? "–"}</td>
                <td>
                  {published ? <span className="num">{p.price}</span> : (
                    <form action={act} style={{ display: "flex", gap: 6 }}>
                      <input type="hidden" name="what" value="price" /><input type="hidden" name="id" value={p.id} /><input type="hidden" name="back" value={back} />
                      <select className="tiny" name="price" defaultValue={String(p.price ?? p.suggested_price ?? 6)} aria-label={`Price for ${p.name}`}>{[4, 6, 8, 10].map((v) => <option key={v}>{v}</option>)}</select>
                      <button className="btn small secondary">Set</button>
                    </form>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </>
  );
}
