import type { Kit } from "@/lib/kits";
import type { Position } from "@/lib/game/rules";
import { Shirt } from "./Shirt";

export interface PitchPlayer {
  id: number;
  name: string;
  position: Position;
  kit: Kit;
  slot: number; // 1-11 on the pitch, 12-14 bench
  /** Big label under the name: points, or next opponent while picking. */
  stat: string;
  /** Highlight the stat as a score (lime) rather than plain info. */
  statIsScore?: boolean;
  captain?: boolean;
  vice?: boolean;
  dim?: boolean;
  note?: string; // tiny tag, e.g. "IN" / "OUT" / "x2"
}

const ROWS: Position[] = ["FWD", "MID", "DEF", "GK"];

function shortName(n: string) {
  const parts = n.trim().split(/\s+/);
  return parts.length > 1 ? parts[parts.length - 1] : n;
}

function Token({ p, selected, onTap }: { p: PitchPlayer; selected?: boolean; onTap?: (id: number) => void }) {
  const body = (
    <>
      <div className="tok-shirt">
        <Shirt kit={p.kit} keeper={p.position === "GK"} dim={p.dim} />
        {p.captain && <span className="armband c">C</span>}
        {p.vice && <span className="armband v">V</span>}
        {p.note && <span className="tok-note">{p.note}</span>}
      </div>
      <div className="tok-name">{shortName(p.name)}</div>
      <div className={`tok-stat${p.statIsScore ? " score" : ""}`}>{p.stat}</div>
    </>
  );
  const cls = `token${selected ? " selected" : ""}${p.dim ? " dim" : ""}`;
  return onTap ? (
    <button type="button" className={cls} onClick={() => onTap(p.id)} aria-pressed={selected} aria-label={`${p.name}, ${p.position}. Tap to swap`}>
      {body}
    </button>
  ) : (
    <div className={cls}>{body}</div>
  );
}

/** Your eleven on a pitch attacking the far post, with the bench underneath. */
export function Pitch({ players, selected, onTap, benchTitle = "Bench" }: { players: PitchPlayer[]; selected?: number | null; onTap?: (id: number) => void; benchTitle?: string }) {
  const xi = players.filter((p) => p.slot <= 11);
  const bench = players.filter((p) => p.slot > 11).sort((a, b) => a.slot - b.slot);
  return (
    <div className="pitch-wrap">
      <div className="pitch">
        <svg className="pitch-lines" viewBox="0 0 100 140" preserveAspectRatio="none" aria-hidden>
          <rect x="4" y="3" width="92" height="134" rx="1" />
          <rect x="22" y="3" width="56" height="22" />
          <rect x="37" y="3" width="26" height="8" />
          <path d="M40 25 A12 10 0 0 0 60 25" />
          <circle cx="50" cy="18" r="0.7" className="dot" />
          <path d="M4 137 L96 137" />
          <path d="M36 137 A14 12 0 0 1 64 137" />
        </svg>
        <div className="goal" aria-hidden><span className="post" /></div>
        <div className="pitch-rows">
          {ROWS.map((pos) => (
            <div className="pitch-row" key={pos}>
              {xi.filter((p) => p.position === pos).sort((a, b) => a.slot - b.slot).map((p) => (
                <Token key={p.id} p={p} selected={selected === p.id} onTap={onTap} />
              ))}
            </div>
          ))}
        </div>
      </div>
      <div className="bench">
        <div className="bench-title">{benchTitle}</div>
        <div className="bench-row">
          {bench.map((p) => (
            <div key={p.id} className="bench-slot">
              <span className="bench-num">{p.slot === 12 ? "GK" : p.slot - 12}</span>
              <Token p={p} selected={selected === p.id} onTap={onTap} />
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}

export interface BoardSlot {
  position: Position;
  player?: { id: number; name: string; kit: Kit; stat: string; note?: string };
}

/** The whole 14-player squad on a pitch, with empty places to fill (squad builder and transfers). */
export function SquadBoard({ slots, onTapEmpty, onTapPlayer, selected }: { slots: BoardSlot[]; onTapEmpty?: (pos: Position) => void; onTapPlayer?: (id: number) => void; selected?: number | null }) {
  return (
    <div className="pitch-wrap">
      <div className="pitch" style={{ minHeight: 0, paddingBottom: 22 }}>
        <svg className="pitch-lines" viewBox="0 0 100 140" preserveAspectRatio="none" aria-hidden>
          <rect x="4" y="3" width="92" height="134" rx="1" />
          <rect x="22" y="3" width="56" height="22" />
          <rect x="37" y="3" width="26" height="8" />
          <path d="M40 25 A12 10 0 0 0 60 25" />
          <path d="M36 137 A14 12 0 0 1 64 137" />
        </svg>
        <div className="goal" aria-hidden><span className="post" /></div>
        <div className="pitch-rows" style={{ minHeight: 400 }}>
          {ROWS.map((pos) => (
            <div className="pitch-row" key={pos}>
              {slots.map((s, i) => ({ s, i })).filter(({ s }) => s.position === pos).map(({ s, i }) =>
                s.player ? (
                  <Token
                    key={s.player.id}
                    p={{ id: s.player.id, name: s.player.name, position: pos, kit: s.player.kit, slot: 1, stat: s.player.stat, note: s.player.note }}
                    selected={selected === s.player.id}
                    onTap={onTapPlayer}
                  />
                ) : (
                  <button key={`e${i}`} type="button" className="token empty" onClick={() => onTapEmpty?.(pos)} aria-label={`Add a ${pos}`}>
                    <div className="tok-shirt"><svg viewBox="0 0 64 64" width={52} height={52} aria-hidden><path d="M21 7 L11 11 L2 21 L9 31 L15 27 L15 60 L49 60 L49 27 L55 31 L62 21 L53 11 L43 7 Q38 14 32 14 Q26 14 21 7 Z" fill="rgba(255,255,255,0.08)" stroke="rgba(255,255,255,0.55)" strokeDasharray="3 3" /><path d="M32 28 v14 M25 35 h14" stroke="#c8ff2e" strokeWidth="3" strokeLinecap="round" /></svg></div>
                    <div className="tok-name" style={{ background: "rgba(255,255,255,0.14)", color: "#fff" }}>{pos}</div>
                  </button>
                ),
              )}
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}
