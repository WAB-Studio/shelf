import "server-only";

import { sql, type SQL } from "drizzle-orm";

import type { Transaction } from "@/db/session";
import {
  agreedCategory,
  LEARNED_KEY_MAX_LENGTH,
  LEARNED_KEY_MIN_LENGTH,
  LEARNED_WINDOW_MONTHS,
} from "@/lib/ingest/learned-category";

// A name without case, accents, digits or punctuation: «NETFLIX.COM 4412» and «Netflix.com 9921» are one.
// The one spelling of a counterparty key, shared by repeated-charge detection (RF-184) and the learned
// category (RF-210), so what one calls the same series the other calls the same counterparty.
export function patternKeySql(text: SQL): SQL {
  return sql`nullif(btrim(regexp_replace(
    translate(lower(coalesce(${text}, '')), 'áàâäãéèêëíìîïóòôöõúùûüñç', 'aaaaaeeeeiiiiooooouuuunc'),
    '[^a-z]+', ' ', 'g')), '')`;
}

export type LearnedCategoryArgs = {
  // What names the counterparty: the merchant the message carried and the description the proposal has.
  merchantLabel: string | null;
  description: string | null;
  // The movement type the proposal would become; a category of the other type never applies.
  kind: "income" | "expense";
  // The fund the proposal's account belongs to (null: personal). Undefined: the account is not known, and
  // every scope the person can read counts.
  groupId: string | null | undefined;
  today: string;
};

/**
 * The category the person's latest single-category movements of this counterparty agree on, or null.
 * A movement is of the counterparty when its description, or the merchant of the delivery that became
 * it, reads as the same key as the proposal's. One statement; RLS scopes the movements, so a person
 * reads their own and their fund's and no one else's.
 */
export async function learnedCategoryId(
  tx: Transaction,
  { merchantLabel, description, kind, groupId, today }: LearnedCategoryArgs,
): Promise<string | null> {
  if (merchantLabel === null && description === null) return null;

  const scope = groupId === undefined ? sql`true` : sql`t.group_id is not distinct from ${groupId}::uuid`;
  const rows = await tx.execute<{ categoryId: string }>(sql`
    with wanted as (
      select k from (
        select ${patternKeySql(sql`${merchantLabel}::text`)} as k
        union all
        select ${patternKeySql(sql`${description}::text`)}
      ) keys
      where length(k) between ${LEARNED_KEY_MIN_LENGTH}::int and ${LEARNED_KEY_MAX_LENGTH}::int
    )
    select s.category_id as "categoryId"
    from transactions t
    join transaction_splits s on s.transaction_id = t.id
    left join lateral (
      select d.merchant_label from ingest_deliveries d where d.transaction_id = t.id limit 1
    ) d on true
    where exists (select 1 from wanted)
      and t.kind = ${kind}
      and t.reconciliation_id is null
      and t.occurred_at >= ${today}::date - make_interval(months => ${LEARNED_WINDOW_MONTHS}::int)
      and ${scope}
      and (select count(*) from transaction_splits x where x.transaction_id = t.id) = 1
      and exists (
        select 1 from wanted w
        where w.k = ${patternKeySql(sql`t.description`)} or w.k = ${patternKeySql(sql`d.merchant_label`)}
      )
    order by t.occurred_at desc, t.created_at desc, t.id desc
    limit 2
  `);

  return agreedCategory(rows.map((row) => row.categoryId));
}
