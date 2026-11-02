// Scores one player's match (spec section 3). Pure: same inputs, same answer.
import type { Position } from "../game/rules";
import { MEASURE_FIELDS, MEASURE_LABELS, type MeasureKey, type ScoringRules, type StatLine } from "./rules";

export interface BreakdownLine {
  key: MeasureKey;
  label: string;
  value: number; // e.g. number of goals, minutes, saves
  points: number;
}

export interface PlayerMatchScore {
  points: number;
  minutes: number;
  breakdown: BreakdownLine[];
  /** Measures that could not be scored yet because a needed number is missing. */
  pending: MeasureKey[];
}

function applies(rules: ScoringRules, key: MeasureKey, pos: Position): boolean {
  const m = rules[key];
  return m.enabled && m.eligible.includes(pos);
}

export function scorePlayerMatch(stats: StatLine, position: Position, rules: ScoringRules): PlayerMatchScore {
  const breakdown: BreakdownLine[] = [];
  const pending: MeasureKey[] = [];
  const add = (key: MeasureKey, value: number, points: number) => {
    if (points !== 0) breakdown.push({ key, label: MEASURE_LABELS[key], value, points });
  };
  const missing = (key: MeasureKey) => MEASURE_FIELDS[key].some((f) => stats[f] === null);

  const keys: MeasureKey[] = ["minutes", "goal", "assist", "cleanSheet", "conceded", "saves", "yellow", "red", "ownGoal", "penSaved", "penMissed"];
  for (const key of keys) {
    if (!applies(rules, key, position)) continue;
    if (missing(key)) {
      // A needed number is unknown: score nothing for this measure yet and label it pending.
      pending.push(key);
      continue;
    }
    const s = stats as { [K in keyof StatLine]: number };
    switch (key) {
      case "minutes": {
        const r = rules.minutes;
        if (s.minutes >= r.threshold) add(key, s.minutes, r.longPoints);
        else if (s.minutes > 0) add(key, s.minutes, r.shortPoints);
        break;
      }
      case "goal":
        add(key, s.goals, s.goals * rules.goal.points[position]);
        break;
      case "assist":
        add(key, s.assists, s.assists * rules.assist.points[position]);
        break;
      case "cleanSheet":
        if (s.minutes >= rules.cleanSheet.minMinutes && s.clubConceded === 0) add(key, 1, rules.cleanSheet.points[position]);
        break;
      case "conceded":
        if (s.minutes >= rules.conceded.minMinutes) {
          const blocks = Math.floor(s.clubConceded / rules.conceded.per);
          add(key, s.clubConceded, blocks * rules.conceded.points[position]);
        }
        break;
      case "saves": {
        const blocks = Math.floor(s.saves / rules.saves.per);
        add(key, s.saves, blocks * rules.saves.points[position]);
        break;
      }
      case "yellow": {
        // A sending-off replaces the yellow (a second yellow counts only as the red).
        const replaced = rules.red.enabled && rules.red.replacesYellow && rules.red.eligible.includes(position) && s.red > 0;
        if (!replaced) add(key, s.yellow, Math.min(s.yellow, 1) * rules.yellow.points[position]);
        break;
      }
      case "red":
        add(key, s.red, Math.min(s.red, 1) * rules.red.points[position]);
        break;
      case "ownGoal":
        add(key, s.ownGoals, s.ownGoals * rules.ownGoal.points[position]);
        break;
      case "penSaved":
        add(key, s.penSaved, s.penSaved * rules.penSaved.points[position]);
        break;
      case "penMissed":
        add(key, s.penMissed, s.penMissed * rules.penMissed.points[position]);
        break;
    }
  }
  return {
    points: breakdown.reduce((sum, b) => sum + b.points, 0),
    minutes: stats.minutes ?? 0,
    breakdown,
    pending,
  };
}
