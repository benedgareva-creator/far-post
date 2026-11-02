"use server";
import { z } from "zod";
import { requireUser } from "@/lib/auth";
import { now as gameNow } from "@/lib/clock";
import { createSquad, GameError, makeTransfers } from "@/lib/services/teams";

type Result = { ok: boolean; message: string };

async function run(fn: () => Promise<unknown>, ok: string): Promise<Result> {
  try {
    await fn();
    return { ok: true, message: ok };
  } catch (e) {
    if (e instanceof GameError) return { ok: false, message: e.message };
    if ((e as { code?: string }).code === "40001") return { ok: false, message: "Something changed at the same moment. Please try again." };
    throw e;
  }
}

export async function createSquadAction(ids: unknown): Promise<Result> {
  const user = await requireUser();
  const parsed = z.array(z.number().int()).max(14).safeParse(ids);
  if (!parsed.success) return { ok: false, message: "That squad could not be read." };
  const now = await gameNow();
  return run(() => createSquad(user.id, parsed.data, now), "Squad saved. Now set your lineup and captain.");
}

export async function transferAction(swaps: unknown): Promise<Result> {
  const user = await requireUser();
  const parsed = z.array(z.object({ out: z.number().int(), in: z.number().int() })).min(1).max(14).safeParse(swaps);
  if (!parsed.success) return { ok: false, message: "Those transfers could not be read." };
  const now = await gameNow();
  return run(() => makeTransfers(user.id, parsed.data, now), `Transfer${parsed.data.length > 1 ? "s" : ""} confirmed.`);
}
