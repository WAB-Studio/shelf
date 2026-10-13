import "server-only";

import { eq, sql } from "drizzle-orm";

import { modelCalls } from "@/db/schema";
import { getPerson, withGoalsDb } from "@/lib/session";
import { TIME_ZONE } from "@/lib/zone";

export const MODEL_CALLS_DAILY_CAP = 10;
export const CHAT_CALLS_DAILY_CAP = 50;

export type ModelCallOutcome = "ok" | "failed" | "invalid" | "empty";

/**
 * Claims one model call before it is made (RNP-13, RNP-21): the row lands only
 * while the person's count for the zone's today, of the same kind, is under that
 * kind's cap, `null` otherwise. The import (`paste`, `file`) and the chat count
 * apart.
 * One statement, so the count and the insert share a round trip. Two claims
 * racing at nine may both land: a person's own double tap, accepted. The day
 * is the column default's, the real one even under `PULSAR_CLOCK`.
 */
export async function claimModelCall(
  model: string,
  source: "paste" | "file" | "chat",
): Promise<{ id: string } | null> {
  const person = await getPerson();
  if (!person) throw new Error("claimModelCall called without a verified session");

  const chat = source === "chat";
  const cap = chat ? CHAT_CALLS_DAILY_CAP : MODEL_CALLS_DAILY_CAP;
  const rows = await withGoalsDb((tx) =>
    tx.execute<{ id: string }>(sql`
      insert into goals.model_calls (user_id, model, source)
      select ${person.id}::uuid, ${model}, ${source}
      where (
        select count(*) from goals.model_calls
        where user_id = ${person.id}::uuid and day = (now() at time zone ${TIME_ZONE})::date
          and (source = 'chat') = ${chat}
      ) < ${cap}
      returning id
    `),
  );

  return rows[0] ? { id: rows[0].id } : null;
}

// True when the person's own claimed row took the answer.
export async function settleModelCall(
  id: string,
  result: { inputTokens: number; outputTokens: number; outcome: ModelCallOutcome },
): Promise<boolean> {
  const rows = await withGoalsDb((tx) =>
    tx
      .update(modelCalls)
      .set({
        inputTokens: result.inputTokens,
        outputTokens: result.outputTokens,
        outcome: result.outcome,
      })
      .where(eq(modelCalls.id, id))
      .returning({ id: modelCalls.id }),
  );

  return rows.length === 1;
}
