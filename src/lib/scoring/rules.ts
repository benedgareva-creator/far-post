// Editable scoring rules (spec section 3). Ben edits points, thresholds and
// eligible positions in Admin > Scoring. A week keeps the rules it locked with.
import { z } from "zod";
import type { Position } from "../game/rules";

const posMap = z.object({ GK: z.number().int(), DEF: z.number().int(), MID: z.number().int(), FWD: z.number().int() });
const positions = z.array(z.enum(["GK", "DEF", "MID", "FWD"]));

const countMeasure = z.object({ enabled: z.boolean(), eligible: positions, points: posMap });
const thresholdMeasure = countMeasure.extend({ minMinutes: z.number().int().min(0).max(130) });
const blockMeasure = countMeasure.extend({ per: z.number().int().min(1).max(20) });
const concededMeasure = blockMeasure.extend({ minMinutes: z.number().int().min(0).max(130) });

export const scoringRulesSchema = z.object({
  version: z.literal(1),
  minutes: z.object({
    enabled: z.boolean(),
    eligible: positions,
    threshold: z.number().int().min(1).max(130), // 60
    shortPoints: z.number().int(), // 1-59 minutes
    longPoints: z.number().int(), // 60+ minutes (total, not extra)
  }),
  goal: countMeasure,
  assist: countMeasure,
  cleanSheet: thresholdMeasure,
  conceded: concededMeasure,
  saves: blockMeasure,
  yellow: countMeasure,
  red: countMeasure.extend({ replacesYellow: z.boolean() }),
  ownGoal: countMeasure,
  penSaved: countMeasure,
  penMissed: countMeasure,
});

export type ScoringRules = z.infer<typeof scoringRulesSchema>;
export type MeasureKey = Exclude<keyof ScoringRules, "version">;

const ALL: Position[] = ["GK", "DEF", "MID", "FWD"];
const all = (n: number) => ({ GK: n, DEF: n, MID: n, FWD: n });

export const DEFAULT_RULES: ScoringRules = {
  version: 1,
  minutes: { enabled: true, eligible: ALL, threshold: 60, shortPoints: 1, longPoints: 2 },
  goal: { enabled: true, eligible: ALL, points: { GK: 7, DEF: 7, MID: 6, FWD: 5 } },
  assist: { enabled: true, eligible: ALL, points: all(4) },
  cleanSheet: { enabled: true, eligible: ["GK", "DEF", "MID"], minMinutes: 60, points: { GK: 5, DEF: 5, MID: 1, FWD: 0 } },
  conceded: { enabled: true, eligible: ["GK", "DEF"], per: 2, minMinutes: 60, points: { GK: -1, DEF: -1, MID: 0, FWD: 0 } },
  saves: { enabled: true, eligible: ["GK"], per: 4, points: { GK: 1, DEF: 0, MID: 0, FWD: 0 } },
  yellow: { enabled: true, eligible: ALL, points: all(-1) },
  red: { enabled: true, eligible: ALL, points: all(-3), replacesYellow: true },
  ownGoal: { enabled: true, eligible: ALL, points: all(-2) },
  penSaved: { enabled: true, eligible: ALL, points: all(5) },
  penMissed: { enabled: true, eligible: ALL, points: all(-2) },
};

export const MEASURE_LABELS: Record<MeasureKey, string> = {
  minutes: "Minutes played",
  goal: "Goal",
  assist: "Assist",
  cleanSheet: "Clean sheet",
  conceded: "Goals conceded",
  saves: "Saves",
  yellow: "Yellow card",
  red: "Sending-off",
  ownGoal: "Own goal",
  penSaved: "Penalty saved",
  penMissed: "Penalty missed",
};

/** Which stored statistic each measure needs (for "pending" labels). */
export const MEASURE_FIELDS: Record<MeasureKey, (keyof StatLine)[]> = {
  minutes: ["minutes"],
  goal: ["goals"],
  assist: ["assists"],
  cleanSheet: ["minutes", "clubConceded"],
  conceded: ["minutes", "clubConceded"],
  saves: ["saves"],
  yellow: ["yellow", "red"],
  red: ["red"],
  ownGoal: ["ownGoals"],
  penSaved: ["penSaved"],
  penMissed: ["penMissed"],
};

/** One player's numbers in one match. null = not known yet (stays pending). */
export interface StatLine {
  minutes: number | null;
  goals: number | null;
  assists: number | null;
  saves: number | null;
  yellow: number | null;
  red: number | null;
  ownGoals: number | null;
  penSaved: number | null;
  penMissed: number | null;
  clubConceded: number | null;
}

export function parseRules(json: unknown): ScoringRules {
  return scoringRulesSchema.parse(json);
}
