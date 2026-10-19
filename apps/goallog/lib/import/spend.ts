import "server-only";

import { eq, sql } from "drizzle-orm";

import { db } from "@/db/client";
import { modelCalls } from "@/db/schema";
import { getPerson, withGoalsDb } from "@/lib/session";
import { TIME_ZONE } from "@/lib/zone";

export const MODEL_CALLS_DAILY_CAP = 10;
export const CHAT_CALLS_DAILY_CAP = 50;

// Every model call the app makes in a day, all persons together (RP-126): ten times the import cap and
// five times the chat cap, so ten persons spending theirs in full fit and a minted crowd does not.
export const APP_MODEL_CALLS_DAILY_CAP_DEFAULT = 10 * MODEL_CALLS_DAILY_CAP + 5 * CHAT_CALLS_DAILY_CAP;

// Read at each claim, so a deploy changes it with its env and a check sets it low.
export function appModelCallsDailyCap(): number {
  const raw = process.env.APP_MODEL_CALLS_DAILY_CAP?.trim();
  if (raw && /^[0-9]+$/.test(raw)) return Number(raw);
  return APP_MODEL_CALLS_DAILY_CAP_DEFAULT;
}

// The second pass of an import (903c) is claimed on the read's own source, under this model name; the
// cap counts every row but these.
export const FOLLOW_UP_SUFFIX = "/arrange";

export type ModelCallOutcome = "ok" | "failed" | "invalid" | "empty";

/**
 * Claims one model call before it is made (RNP-13, RNP-21): the row lands only
 * while the person's count for the zone's today, of the same kind, is under that
 * kind's cap, `null` otherwise. The import (`paste`, `file`) and the chat count
 * apart.
 * A transaction lock per person and kind comes first, in a statement of its own:
 * the count's snapshot is taken after the wait, so concurrent claims see each
 * other's rows and exactly the cap lands. The day is the column default's, the
 * real one even under `PULSAR_CLOCK`.
 * The whole app's day is capped too (RP-126), by every row of the day, follow-ups included. Its own lock
 * comes second, always in that order, so two claims never wait on each other crosswise; it serializes
 * every claim of the app for the length of one insert.
 */
export async function claimModelCall(
  model: string,
  source: "paste" | "file" | "chat",
): Promise<{ id: string } | null> {
  const person = await getPerson();
  if (!person) throw new Error("claimModelCall called without a verified session");

  const chat = source === "chat";
  const cap = chat ? CHAT_CALLS_DAILY_CAP : MODEL_CALLS_DAILY_CAP;
  // The app's count reads every person's rows, which the person's own role cannot see: this door is the
  // owner's, like the OAuth throttle's, and writes only the verified person's row.
  const rows = await db.transaction(async (tx) => {
    await tx.execute(sql`select pg_advisory_xact_lock(hashtextextended(${`${person.id}:${chat ? "chat" : "import"}`}, 0))`);
    await tx.execute(sql`select pg_advisory_xact_lock(hashtextextended('app:model-calls', 0))`);
    return tx.execute<{ id: string }>(sql`
      insert into goals.model_calls (user_id, model, source)
      select ${person.id}::uuid, ${model}, ${source}
      where (
        select count(*) from goals.model_calls
        where user_id = ${person.id}::uuid and day = (now() at time zone ${TIME_ZONE})::date
          and (source = 'chat') = ${chat} and model not like ${`%${FOLLOW_UP_SUFFIX}`}
      ) < ${cap}
      and (
        select count(*) from goals.model_calls where day = (now() at time zone ${TIME_ZONE})::date
      ) < ${appModelCallsDailyCap()}
      returning id
    `);
  });

  return rows[0] ? { id: rows[0].id } : null;
}

/**
 * True when the whole app's day is spent, to say so after a refused claim; the owner's door, since the
 * count is every person's.
 */
export async function appCapReached(): Promise<boolean> {
  const rows = await db.execute<{ spent: boolean }>(sql`
    select count(*) >= ${appModelCallsDailyCap()} as spent from goals.model_calls
    where day = (now() at time zone ${TIME_ZONE})::date
  `);
  return rows[0]?.spent === true;
}

/**
 * Claims the second pass of an import (903c) outside the read cap, but never ahead of a read: the row
 * lands only while the person's follow-ups today are fewer than their import reads today, counted under
 * the import lock the reads take, so a pass is one for one with a read that took its own claim.
 * Settled by `settleModelCall` like the read.
 */
export async function claimFollowUp(model: string, source: "paste" | "file"): Promise<{ id: string } | null> {
  const person = await getPerson();
  if (!person) throw new Error("claimFollowUp called without a verified session");

  const rows = await db.transaction(async (tx) => {
    await tx.execute(sql`select pg_advisory_xact_lock(hashtextextended(${`${person.id}:import`}, 0))`);
    return tx.execute<{ id: string }>(sql`
      insert into goals.model_calls (user_id, model, source)
      select ${person.id}::uuid, ${`${model}${FOLLOW_UP_SUFFIX}`}, ${source}
      where (
        select count(*) from goals.model_calls
        where user_id = ${person.id}::uuid and day = (now() at time zone ${TIME_ZONE})::date
          and source in ('paste', 'file') and model like ${`%${FOLLOW_UP_SUFFIX}`}
      ) < (
        select count(*) from goals.model_calls
        where user_id = ${person.id}::uuid and day = (now() at time zone ${TIME_ZONE})::date
          and source in ('paste', 'file') and model not like ${`%${FOLLOW_UP_SUFFIX}`}
      )
      returning id
    `);
  });

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
