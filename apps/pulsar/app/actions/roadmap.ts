"use server";

import { revalidatePath } from "next/cache";

import { sql } from "drizzle-orm";
import { z } from "zod";

import { getPerson, withGoalsDb } from "@/lib/session";
import { monthStart } from "@/lib/validation/budget";
import {
  dismissPlanNoticeSchema,
  dismissPlanNoticesSchema,
  setRhythmSchema,
  type DismissPlanNoticeInput,
  type DismissPlanNoticesInput,
} from "@/lib/validation/rhythm";
import { TIME_UNITS } from "@/lib/units/time";
import { TIME_ZONE, todayInZone } from "@/lib/zone";
import { messageKey, type MessageKey } from "@/i18n/translator";
import { NamedError } from "@/lib/actions/named-error";

// A month holds 44 640 minutes at most; other units answer to the column's cap.
const MAX_TIME_RHYTHM = 44_640;

export type SetRhythmResult = { ok: true } | { ok: false; error: MessageKey };
export type DismissPlanNoticeResult = { ok: true } | { ok: false; error: MessageKey };

/**
 * Sets or changes a goal's rhythm (RP-52) in one statement. The CTEs read one
 * snapshot, so `g.rhythm` is the old value: it fills every closed month of the
 * span that has no amount with its share of it (`plannedOf`, RP-74: the plan
 * those months were lived against), the integer division its floor, and
 * only the first rhythm (old null) sends the goal's undone top-level plan
 * tasks back to the plan. A task is done when it has a fact, or when it has
 * children and each of them has one. The guard trigger already leaves a
 * task with a fact alone; the clause says it again for the parent. The first
 * rhythm also marks last month seen: the plan starts there, so it has no
 * month to have moved.
 * A goal the person cannot see, or one refused, updates and inserts nothing,
 * so the refusal needs no rollback.
 */
export async function setRhythm(input: unknown): Promise<SetRhythmResult> {
  const parsed = setRhythmSchema.safeParse(input);
  if (!parsed.success) {
    const key = messageKey(parsed.error.issues[0].message);
    const raw = input as { goalId?: unknown; amount?: unknown } | null;
    // Past the column's cap the words depend on the unit: a time unit speaks hours, any other a plain count.
    if (key !== "roadmap.errors.rhythmRange" || typeof raw?.amount !== "number" || raw.amount <= 1_000_000) {
      return { ok: false, error: key };
    }
    const person = await getPerson();
    if (!person || typeof raw.goalId !== "string" || !z.uuid().safeParse(raw.goalId).success) return { ok: false, error: key };
    const rows = await withGoalsDb((tx) =>
      tx.execute<{ timed: boolean }>(sql`
        select coalesce(lower(trim(measure_unit)) = any(array[${sql.join(TIME_UNITS.map((u) => sql`${u}`), sql`, `)}]::text[]), false) as timed
        from goals where id = ${raw.goalId}
      `),
    );
    return { ok: false, error: rows[0] && !rows[0].timed ? "roadmap.errors.rhythmRangeAny" : key };
  }
  const { goalId, amount } = parsed.data;

  const person = await getPerson();
  if (!person) return { ok: false, error: "month.errors.signedOut" };

  const today = todayInZone();
  const timeUnits = sql`array[${sql.join(
    TIME_UNITS.map((unit) => sql`${unit}`),
    sql`, `,
  )}]::text[]`;

  const rows = await withGoalsDb((tx) =>
    tx.execute<{ measured: boolean; timed: boolean; open: boolean; holder: boolean }>(sql`
      with g as (
        select id, rhythm, measure_unit, horizon, archived_at,
               (created_at at time zone ${TIME_ZONE})::date as opened
        from goals where id = ${goalId}
      ),
      ok as (
        select * from g
        where measure_unit is not null and archived_at is null and (horizon is null or horizon > ${today}::date)
          and not (lower(trim(measure_unit)) = any(${timeUnits}) and ${amount}::int > ${MAX_TIME_RHYTHM}::int)
          and not exists (select 1 from goals c where c.parent_id = g.id and c.archived_at is null)
      ),
      upd as (
        update goals set rhythm = ${amount},
          plan_seen = case when rhythm is null and lower(trim(measure_unit)) = any(${timeUnits})
            then greatest(plan_seen, (date_trunc('month', ${today}::date) - interval '1 month')::date)
            else plan_seen end
        where id in (select id from ok) returning id
      ),
      ins as (
        insert into month_budgets (user_id, goal_id, month, amount)
        select ${person.id}, ok.id, d.first,
               ok.rhythm * (least(ok.horizon, d.next) - greatest(ok.opened, d.first)) / (d.next - d.first)
        from ok, generate_series(
          date_trunc('month', ok.opened), date_trunc('month', ${today}::date) - interval '1 month', interval '1 month'
        ) m, lateral (select m::date as first, (m + interval '1 month')::date as next) d
        where ok.rhythm is not null
        on conflict (goal_id, month) do nothing
        returning 1
      ),
      rel as (
        update one_offs set planned_month = null
        where goal_id in (select id from ok where rhythm is null and lower(trim(measure_unit)) = any(${timeUnits}))
          and parent_id is null and planned_month is not null
          and not exists (select 1 from facts f where f.one_off_id = one_offs.id)
          and not (
            exists (select 1 from one_offs c where c.parent_id = one_offs.id)
            and not exists (
              select 1 from one_offs c where c.parent_id = one_offs.id
                and not exists (select 1 from facts f where f.one_off_id = c.id)
            )
          )
        returning 1
      )
      select measure_unit is not null as measured,
             coalesce(lower(trim(measure_unit)) = any(${timeUnits}), false) as timed,
             archived_at is null and (horizon is null or horizon > ${today}::date) as open,
             exists (select 1 from goals c where c.parent_id = g.id and c.archived_at is null) as holder
      from g
    `),
  );

  const goal = rows[0];
  if (!goal) return { ok: false, error: "month.errors.notFound" };
  if (!goal.open) return { ok: false, error: "month.errors.closed" };
  if (goal.holder) return { ok: false, error: "tree.errors.holderNoRhythm" };
  if (!goal.measured) return { ok: false, error: "roadmap.errors.rhythmNoMeasure" };
  if (goal.timed && amount > MAX_TIME_RHYTHM) return { ok: false, error: "roadmap.errors.rhythmRange" };

  revalidatePath(`/metas/${goalId}`, "layout");
  revalidatePath("/");
  return { ok: true };
}

/**
 * Dismisses Hoy's notices for months already over (RP-53) in one statement,
 * all or nothing. `greatest` ignores `null`, so the first dismissal sets the
 * column and an older month never pulls it back. The policies scope each row
 * to its owner: another person's goal matches nothing, the count falls short
 * and the throw rolls back what the others wrote. One goal sent twice keeps
 * its latest month, since `update ... from` applies one arbitrary match.
 */
export async function dismissPlanNotices(
  input: DismissPlanNoticesInput,
): Promise<DismissPlanNoticeResult> {
  const parsed = dismissPlanNoticesSchema.safeParse(input);
  if (!parsed.success) return { ok: false, error: messageKey(parsed.error.issues[0].message) };

  const person = await getPerson();
  if (!person) return { ok: false, error: "month.errors.signedOut" };

  const current = todayInZone().slice(0, 7);
  if (parsed.data.notices.some(({ month }) => month >= current)) {
    return { ok: false, error: "month.errors.monthInvalid" };
  }

  const latest = new Map<string, string>();
  for (const { goalId, month } of parsed.data.notices) {
    const seen = latest.get(goalId);
    if (seen === undefined || month > seen) latest.set(goalId, month);
  }
  const payload = JSON.stringify([...latest].map(([id, month]) => ({ id, month: monthStart(month) })));

  try {
    await withGoalsDb(async (tx) => {
      const rows = await tx.execute(sql`
        update goals g set plan_seen = greatest(g.plan_seen, v.month)
        from jsonb_to_recordset(${payload}::jsonb) as v(id uuid, month date)
        where g.id = v.id returning g.id
      `);
      if (rows.length < latest.size) throw new NamedError("month.errors.notFound");
    });
  } catch (error) {
    if (error instanceof NamedError) return { ok: false, error: messageKey(error.message) };
    throw error;
  }

  revalidatePath("/");
  return { ok: true };
}

export async function dismissPlanNotice(
  input: DismissPlanNoticeInput,
): Promise<DismissPlanNoticeResult> {
  const parsed = dismissPlanNoticeSchema.safeParse(input);
  if (!parsed.success) return { ok: false, error: messageKey(parsed.error.issues[0].message) };
  return dismissPlanNotices({ notices: [parsed.data] });
}
