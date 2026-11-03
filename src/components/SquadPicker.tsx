"use client";
import { useMemo, useState, useTransition } from "react";
import { BUDGET, MAX_PER_CLUB, SQUAD_SHAPE, POSITION_NAMES, type Position } from "@/lib/game/rules";
import { createSquadAction, transferAction } from "@/app/transfers/actions";
import type { Kit } from "@/lib/kits";
import { Shirt } from "./Shirt";
import { SquadBoard, type BoardSlot } from "./Pitch";

export interface CatPlayer {
  id: number;
  name: string;
  position: Position;
  price: number;
  club_id: number;
  club_short: string;
  points: number;
  kit: Kit;
  /** Matches in the Week being picked for, e.g. "BRW (H)", "2 games: BRW (H), KST (A)" or "No match". */
  next?: string;
}

function board(players: (CatPlayer & { label?: string; note?: string })[]): BoardSlot[] {
  return POS.flatMap((pos) => {
    const here = players.filter((p) => p.position === pos);
    return Array.from({ length: SQUAD_SHAPE[pos] }, (_, i) => ({
      position: pos,
      player: here[i] ? { id: here[i].id, name: here[i].name, kit: here[i].kit, stat: here[i].label ?? `${here[i].club_short} · ${here[i].price}`, note: here[i].note } : undefined,
    }));
  });
}

const POS: Position[] = ["GK", "DEF", "MID", "FWD"];

function PlayerList({ players, onPick, disabled, filterPos, setFilterPos, owned }: {
  players: CatPlayer[];
  onPick: (p: CatPlayer) => void;
  disabled: (p: CatPlayer) => string | null;
  filterPos: Position | null;
  setFilterPos?: (p: Position | null) => void;
  owned: Set<number>;
}) {
  const [search, setSearch] = useState("");
  const [maxPrice, setMaxPrice] = useState(10);
  const shown = players
    .filter((p) => !owned.has(p.id))
    .filter((p) => !filterPos || p.position === filterPos)
    .filter((p) => p.price <= maxPrice)
    .filter((p) => !search || `${p.name} ${p.club_short}`.toLowerCase().includes(search.toLowerCase()))
    .sort((a, b) => b.points - a.points || b.price - a.price)
    .slice(0, 60);
  return (
    <div>
      {setFilterPos && (
        <div className="seg" style={{ marginBottom: 10 }}>
          <button className={`chip${!filterPos ? " on" : ""}`} onClick={() => setFilterPos(null)}>All</button>
          {POS.map((p) => <button key={p} className={`chip${filterPos === p ? " on" : ""}`} onClick={() => setFilterPos(p)}>{p}</button>)}
        </div>
      )}
      <div className="grid2">
        <input placeholder="Search name or club" value={search} onChange={(e) => setSearch(e.target.value)} aria-label="Search players" />
        <select value={maxPrice} onChange={(e) => setMaxPrice(Number(e.target.value))} aria-label="Maximum price">
          {[10, 8, 6, 4].map((v) => <option key={v} value={v}>Up to {v}</option>)}
        </select>
      </div>
      <div className="list mt">
        {shown.map((p) => {
          const why = disabled(p);
          return (
            <button key={p.id} className={`row${why ? " dim" : ""}`} style={{ all: "unset", display: "flex", alignItems: "center", gap: 12, padding: "12px 16px", borderBottom: "1px solid var(--line)", cursor: why ? "default" : "pointer", width: "100%", boxSizing: "border-box", opacity: why ? 0.5 : 1 }} onClick={() => !why && onPick(p)} aria-disabled={!!why} title={why ?? `Add ${p.name}`}>
              <span className="mini-shirt"><Shirt kit={p.kit} keeper={p.position === "GK"} size={36} /></span>
              <div className="grow" style={{ flex: 1, minWidth: 0 }}>
                <div className="title">{p.name}</div>
                <div className="meta">{p.position} · {p.club_short} · {p.points} pts{p.next ? ` · ${p.next}` : ""}{why ? ` · ${why}` : ""}</div>
              </div>
              <div className="pts" style={{ fontSize: 20 }}>{p.price}</div>
            </button>
          );
        })}
        {shown.length === 0 && <div className="empty">No players match.</div>}
      </div>
    </div>
  );
}

export function SquadBuilder({ catalogue }: { catalogue: CatPlayer[] }) {
  const [picked, setPicked] = useState<CatPlayer[]>([]);
  const [filterPos, setFilterPos] = useState<Position | null>("GK");
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);
  const [pending, start] = useTransition();
  const spent = picked.reduce((s, p) => s + p.price, 0);
  const clubCount = (id: number) => picked.filter((p) => p.club_id === id).length;
  const posCount = (pos: Position) => picked.filter((p) => p.position === pos).length;
  const disabled = (p: CatPlayer) => {
    if (posCount(p.position) >= SQUAD_SHAPE[p.position]) return `${POSITION_NAMES[p.position]}s full`;
    if (clubCount(p.club_id) >= MAX_PER_CLUB) return `already ${MAX_PER_CLUB} from ${p.club_short}`;
    if (spent + p.price > BUDGET) return "over budget";
    return null;
  };
  const owned = useMemo(() => new Set(picked.map((p) => p.id)), [picked]);
  return (
    <div>
      <div className="hero">
        <div className="spread"><span style={{ fontWeight: 700 }}>New squad</span><span className="pill">{picked.length}/14</span></div>
        <div className="hero-meta">
          {POS.map((p) => <div className="stat" key={p}><span className="num">{posCount(p)}/{SQUAD_SHAPE[p]}</span><span>{p}</span></div>)}
          <div className="stat"><span className="num">{BUDGET - spent}</span><span>Left to spend</span></div>
        </div>
      </div>
      <p className="small">Tap an empty shirt to choose that position, or tap a player to remove them.</p>
      <SquadBoard slots={board(picked)} onTapEmpty={(pos) => { setFilterPos(pos); document.getElementById("market")?.scrollIntoView({ behavior: "smooth" }); }} onTapPlayer={(id) => setPicked(picked.filter((x) => x.id !== id))} />
      {msg && <div className={`notice mt ${msg.ok ? "ok" : "error"}`}>{msg.text}</div>}
      <button className="btn block mt" disabled={picked.length !== 14 || pending} onClick={() => start(async () => {
        const r = await createSquadAction(picked.map((p) => p.id));
        setMsg({ ok: r.ok, text: r.message });
        if (r.ok) window.location.href = "/team";
      })}>{pending ? "Saving…" : picked.length === 14 ? "Save squad" : `Pick ${14 - picked.length} more`}</button>
      <h2 id="market">Add players</h2>
      <PlayerList players={catalogue} owned={owned} filterPos={filterPos} setFilterPos={setFilterPos} disabled={disabled} onPick={(p) => setPicked([...picked, p])} />
    </div>
  );
}

export function TransferMarket({ catalogue, squad, bank, remaining }: { catalogue: CatPlayer[]; squad: (CatPlayer & { purchase_price: number })[]; bank: number; remaining: number | null }) {
  const [swaps, setSwaps] = useState<{ out: CatPlayer & { purchase_price: number }; in: CatPlayer }[]>([]);
  const [selling, setSelling] = useState<(CatPlayer & { purchase_price: number }) | null>(null);
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);
  const [pending, start] = useTransition();
  const after = [...squad.filter((p) => !swaps.some((s) => s.out.id === p.id)).map((p) => ({ ...p, cost: p.purchase_price })), ...swaps.map((s) => ({ ...s.in, cost: s.in.price }))];
  const bankAfter = BUDGET - after.reduce((s, p) => s + p.cost, 0);
  const owned = new Set([...squad.map((p) => p.id), ...swaps.map((s) => s.in.id)]);
  const left = remaining === null ? null : remaining - swaps.length;
  // Club limits and the budget are checked on the finished set of transfers, not one at a time, so
  // swaps that only work together (e.g. trading players between two clubs you already have three
  // from) are possible. Problems show as warnings and block Confirm until they are fixed.
  const disabled = (_p: CatPlayer) => (!selling ? "choose who to sell first" : null);
  const clubCounts = new Map<number, { n: number; short: string }>();
  for (const p of after) clubCounts.set(p.club_id, { n: (clubCounts.get(p.club_id)?.n ?? 0) + 1, short: p.club_short });
  const overClubs = [...clubCounts.values()].filter((c) => c.n > MAX_PER_CLUB);
  const warnings = [
    ...overClubs.map((c) => `${c.n} players from ${c.short}: the most is ${MAX_PER_CLUB}. Sell another ${c.short} player too.`),
    ...(bankAfter < 0 ? [`${-bankAfter} over budget: sell someone more expensive or buy someone cheaper.`] : []),
    ...(left !== null && left < 0 ? ["More transfers than you have left this Week."] : []),
  ];
  return (
    <div>
      <div className="hero">
        <div className="hero-meta" style={{ marginTop: 0, gridTemplateColumns: "1fr 1fr" }}>
          <div className="stat"><span className="num">{bankAfter}</span><span>In the bank</span></div>
          <div className="stat"><span className="num">{left === null ? "∞" : left}</span><span>{left === null ? "Free until first deadline" : "Transfers left this Week"}</span></div>
        </div>
        <div className="small mt">Selling returns what you paid. Prices never change during the season.</div>
      </div>
      {swaps.length > 0 && (
        <>
          <h2>Pending transfers</h2>
          <div className="list">
            {swaps.map((s) => (
              <div className="row" key={s.out.id}>
                <div className="grow"><div className="title">{s.out.name} → {s.in.name}</div><div className="meta">{s.out.position} · {s.out.purchase_price} → {s.in.price}</div></div>
                <button className="chip" onClick={() => setSwaps(swaps.filter((x) => x !== s))}>Undo</button>
              </div>
            ))}
          </div>
          {warnings.map((w) => <div className="notice error mt" key={w}>{w}</div>)}
          <button className="btn block mt" disabled={pending || warnings.length > 0} onClick={() => start(async () => {
            const r = await transferAction(swaps.map((s) => ({ out: s.out.id, in: s.in.id })));
            setMsg({ ok: r.ok, text: r.message });
            if (r.ok) { setSwaps([]); setTimeout(() => window.location.reload(), 600); }
          })}>{pending ? "Confirming…" : `Confirm ${swaps.length} transfer${swaps.length > 1 ? "s" : ""}`}</button>
        </>
      )}
      {msg && <div className={`notice mt ${msg.ok ? "ok" : "error"}`}>{msg.text}</div>}
      <h2>{selling ? `Replace ${selling.name}` : "Tap a player to replace them"}</h2>
      {!selling && (
        <SquadBoard
          slots={board(after.map((p) => ({ ...p, price: p.cost, note: swaps.some((x) => x.in.id === p.id) ? "NEW" : undefined })))}
          onTapPlayer={(id) => {
            const p = squad.find((x) => x.id === id);
            if (p && (left === null || left > 0) && !swaps.some((x) => x.in.id === id)) setSelling(p);
          }}
        />
      )}
      {selling && (
        <>
          <button className="btn secondary small" onClick={() => setSelling(null)}>Cancel</button>
          <div className="mt">
            <PlayerList players={catalogue} owned={owned} filterPos={selling.position} disabled={disabled} onPick={(p) => { setSwaps([...swaps, { out: selling, in: p }]); setSelling(null); }} />
          </div>
        </>
      )}
    </div>
  );
}
