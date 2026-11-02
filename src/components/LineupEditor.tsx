"use client";
import { useMemo, useState, useTransition } from "react";
import { validateLineup, type Position } from "@/lib/game/rules";
import { saveLineupAction } from "@/app/team/actions";

export interface EditorPlayer {
  playerId: number;
  name: string;
  position: Position;
  club: string;
  slot: number;
  isCaptain: boolean;
  isVice: boolean;
  next: string;
}

const ORDER: Position[] = ["GK", "DEF", "MID", "FWD"];

export function LineupEditor({ initial }: { initial: EditorPlayer[] }) {
  const [players, setPlayers] = useState(initial);
  const [selected, setSelected] = useState<number | null>(null);
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);
  const [pending, start] = useTransition();
  const errors = useMemo(() => validateLineup(players), [players]);
  const dirty = JSON.stringify(players) !== JSON.stringify(initial);

  const starters = players.filter((p) => p.slot <= 11).sort((a, b) => ORDER.indexOf(a.position) - ORDER.indexOf(b.position) || a.slot - b.slot);
  const bench = players.filter((p) => p.slot > 11).sort((a, b) => a.slot - b.slot);

  function tap(id: number) {
    setMsg(null);
    if (selected === null) return setSelected(id);
    if (selected === id) return setSelected(null);
    const a = players.find((p) => p.playerId === selected)!;
    const b = players.find((p) => p.playerId === id)!;
    const swapped = players.map((p) => {
      if (p.playerId === a.playerId) return { ...p, slot: b.slot, ...(b.slot > 11 ? { isCaptain: false, isVice: false } : {}) };
      if (p.playerId === b.playerId) return { ...p, slot: a.slot, ...(a.slot > 11 ? { isCaptain: false, isVice: false } : {}) };
      return p;
    });
    // Keep a captain and vice if a starter with the armband was benched.
    const fix = (list: EditorPlayer[]) => {
      const out = [...list];
      const xi = out.filter((p) => p.slot <= 11 && p.position !== "GK");
      if (!out.some((p) => p.isCaptain)) { const c = xi.find((p) => !p.isVice); if (c) c.isCaptain = true; }
      if (!out.some((p) => p.isVice)) { const v = xi.find((p) => !p.isCaptain); if (v) v.isVice = true; }
      return out;
    };
    const next = fix(swapped.map((p) => ({ ...p })));
    const bad = validateLineup(next).filter((e) => !/captain/i.test(e));
    if (bad.length) setMsg({ ok: false, text: bad[0] });
    else setPlayers(next);
    setSelected(null);
  }

  function armband(id: number, kind: "C" | "V") {
    const cap = players.find((p) => p.isCaptain)?.playerId;
    const vice = players.find((p) => p.isVice)?.playerId;
    // Giving the armband to the other armband holder swaps the two roles.
    const newCap = kind === "C" ? id : id === cap ? vice : cap;
    const newVice = kind === "V" ? id : id === vice ? cap : vice;
    setPlayers(players.map((p) => ({ ...p, isCaptain: p.playerId === newCap, isVice: p.playerId === newVice })));
  }

  function save() {
    start(async () => {
      const res = await saveLineupAction(players.map(({ playerId, slot, isCaptain, isVice }) => ({ playerId, slot, isCaptain, isVice })));
      setMsg({ ok: res.ok, text: res.message });
    });
  }

  const row = (p: EditorPlayer, benchLabel?: string) => (
    <div key={p.playerId} className="row" style={{ background: selected === p.playerId ? "var(--accent-soft)" : undefined }}>
      <button onClick={() => tap(p.playerId)} style={{ all: "unset", display: "flex", alignItems: "center", gap: 12, flex: 1, minWidth: 0, cursor: "pointer" }} aria-label={`Select ${p.name} to swap`}>
        <span className="pos">{benchLabel ?? p.position}</span>
        <div className="grow">
          <div className="title">{p.name}</div>
          <div className="meta">{p.club} · {p.next}</div>
        </div>
      </button>
      {p.slot <= 11 && (
        <div style={{ display: "flex", gap: 6 }}>
          <button className={`chip${p.isCaptain ? " on" : ""}`} onClick={() => armband(p.playerId, "C")} aria-pressed={p.isCaptain} aria-label={`Make ${p.name} captain`}>C</button>
          <button className={`chip${p.isVice ? " on" : ""}`} onClick={() => armband(p.playerId, "V")} aria-pressed={p.isVice} aria-label={`Make ${p.name} vice-captain`}>V</button>
        </div>
      )}
    </div>
  );

  return (
    <div>
      <p className="small">Tap two players to swap them. C doubles a player's points; V takes over if your captain does not play.</p>
      <h2>Starting eleven</h2>
      <div className="list">{starters.map((p) => row(p))}</div>
      <h2>Bench (in substitution order)</h2>
      <div className="list">{bench.map((p) => row(p, p.slot === 12 ? "GK" : `${p.slot - 12}.`))}</div>
      {msg && <div className={`notice mt ${msg.ok ? "ok" : "error"}`}>{msg.text}</div>}
      {errors.length > 0 && !msg && <div className="notice error mt">{errors[0]}</div>}
      <button className="btn block mt" onClick={save} disabled={pending || !dirty || errors.length > 0}>{pending ? "Saving…" : dirty ? "Save lineup" : "Saved"}</button>
    </div>
  );
}
