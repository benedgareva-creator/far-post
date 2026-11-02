"use server";
import { requireUser } from "@/lib/auth";
import { now as gameNow } from "@/lib/clock";
import { GameError, saveLineup } from "@/lib/services/teams";
import { z } from "zod";

const schema = z.array(z.object({ playerId: z.number().int(), slot: z.number().int().min(1).max(14), isCaptain: z.boolean(), isVice: z.boolean() })).length(14);

export async function saveLineupAction(entries: unknown): Promise<{ ok: boolean; message: string }> {
  const user = await requireUser();
  const parsed = schema.safeParse(entries);
  if (!parsed.success) return { ok: false, message: "That lineup could not be read." };
  try {
    await saveLineup(user.id, parsed.data, await gameNow());
    return { ok: true, message: "Lineup saved." };
  } catch (e) {
    if (e instanceof GameError) return { ok: false, message: e.message };
    throw e;
  }
}
