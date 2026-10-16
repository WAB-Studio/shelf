import "server-only";

import { asc, eq, or, sql } from "drizzle-orm";

import { insertRow } from "@/db/insert-row";
import { callerGroupId, callerGroupInfo } from "@/db/queries/groups";
import { labels } from "@/db/schema";
import type { Transaction } from "@/db/session";
import { requireUser, withUserDb, withUserDbOrTx } from "@/db/session";

// A label set is read and written for one scope at a time: a user's personal set
// or a group's (RF-70). The scope decides which of the XOR columns is set.
export type LabelScope = { ownerUserId: string } | { groupId: string };

export type LabelRow = {
  id: string;
  name: string;
  color: string | null;
};

// A row carries the scope it was read from: a movement's labels must share its
// scope (RF-70), and the picker tells the two sets apart with no second lookup.
export type ScopedLabelRow = LabelRow & { scope: "personal" | "group" };

// The management screen's row: the label plus what would break if it went away
// (RF-70). Both counts derive from the join and the budgets narrowing on it, and
// neither is ever stored.
export type LabelManagementRow = {
  id: string;
  name: string;
  color: string | null;
  // How many transactions wear the label, through `transaction_labels`.
  movementCount: number;
  budgetCount: number;
};

export type UpdateLabelArgs = {
  labelId: string;
  name: string;
  color: string | null;
};

export type CreateLabelArgs = {
  scope: LabelScope;
  name: string;
  color: string | null;
};

function scopeWhere(scope: LabelScope) {
  return "ownerUserId" in scope
    ? eq(labels.ownerUserId, scope.ownerUserId)
    : eq(labels.groupId, scope.groupId);
}

// The scope's labels, one scope at a time; the policy scopes the rows.
export async function listLabels(scope: LabelScope): Promise<LabelRow[]> {
  return withUserDb(async (tx) =>
    tx
      .select({ id: labels.id, name: labels.name, color: labels.color })
      .from(labels)
      .where(scopeWhere(scope))
      .orderBy(asc(labels.name)),
  );
}

/**
 * Every label a form offers, in ONE statement: the caller's own and their group's,
 * the group resolved by subselect rather than behind a transaction of its own.
 * Personal before the group's, then by name.
 */
export async function listScopedLabels(
  userId: string,
  outerTx?: Transaction,
): Promise<ScopedLabelRow[]> {
  return withUserDbOrTx(outerTx, async (tx) => {
    const rows = await tx
      .select({
        id: labels.id,
        name: labels.name,
        color: labels.color,
        ownerUserId: labels.ownerUserId,
      })
      .from(labels)
      .where(or(eq(labels.ownerUserId, userId), eq(labels.groupId, callerGroupId(userId))))
      .orderBy(asc(sql`${labels.ownerUserId} is null`), asc(labels.name));

    return rows.map(({ ownerUserId, ...label }) => ({
      ...label,
      scope: ownerUserId === null ? ("group" as const) : ("personal" as const),
    }));
  });
}

/**
 * The scope's labels for the management screen, counts along, in ONE round trip:
 * both counts ride as correlated subqueries, never an N+1 follow-up (RF-70).
 * `listLabels` stays countless so the movement form never pays for them.
 *
 * Neither count can name a row the caller may not read: both subqueries run
 * under the same session as the outer select, so `transaction_labels` and
 * `budgets` answer through their own policies.
 */
export async function listManagedLabels(
  scope: LabelScope,
  outerTx?: Transaction,
): Promise<LabelManagementRow[]> {
  // The outer reference is written qualified: drizzle renders an embedded column
  // bare inside a projection, and a bare `id` binds to the subquery's own table.
  const outerId = sql`"labels"."id"`;

  const movementCount = sql<number>`(
    select count(*)::int from transaction_labels tl where tl.label_id = ${outerId}
  )`;

  const budgetCount = sql<number>`(
    select count(*)::int from budgets b where b.label_id = ${outerId}
  )`;

  return withUserDbOrTx(outerTx, async (tx) =>
    tx
      .select({
        id: labels.id,
        name: labels.name,
        color: labels.color,
        movementCount,
        budgetCount,
      })
      .from(labels)
      .where(scopeWhere(scope))
      .orderBy(asc(labels.name)),
  );
}

// The colours already spent in the scope, so a new label defaults to a fresh one.
export async function listUsedLabelColors(
  scope: LabelScope,
  outerTx?: Transaction,
): Promise<string[]> {
  return withUserDbOrTx(outerTx, async (tx) => {
    const rows = await tx
      .selectDistinct({ color: labels.color })
      .from(labels)
      .where(scopeWhere(scope));

    return rows.flatMap((row) => (row.color ? [row.color] : []));
  });
}

export async function createLabel({
  scope,
  name,
  color,
}: CreateLabelArgs): Promise<{ labelId: string }> {
  const ownerUserId = "ownerUserId" in scope ? scope.ownerUserId : null;
  const groupId = "groupId" in scope ? scope.groupId : null;

  return withUserDb(async (tx) => {
    const [row] = await insertRow(
      tx,
      labels,
      { ownerUserId, groupId, name, color },
      { returning: { id: labels.id } },
    );

    return { labelId: row.id };
  });
}

// The placement is immutable, so no scope column is named here; the UPDATE grant
// covers `(name, color)` only. A false row count is a denied or absent label.
export async function updateLabel({
  labelId,
  name,
  color,
}: UpdateLabelArgs): Promise<boolean> {
  return withUserDb(async (tx) => {
    const rows = await tx
      .update(labels)
      .set({ name, color })
      .where(eq(labels.id, labelId))
      .returning({ id: labels.id });

    return rows.length > 0;
  });
}

// The join's ON DELETE cascade detaches the label from its movements; no second statement.
export async function deleteLabel({
  labelId,
}: {
  labelId: string;
}): Promise<boolean> {
  return withUserDb(async (tx) => {
    const rows = await tx
      .delete(labels)
      .where(eq(labels.id, labelId))
      .returning({ id: labels.id });

    return rows.length > 0;
  });
}

/**
 * The labels screen in one transaction (RF-70): both scopes with their counts and
 * spent colours. A personal-only caller gets empty group lists.
 */
export async function getLabelsScreenData(): Promise<{
  groupName: string | null;
  isLeader: boolean;
  personal: LabelManagementRow[];
  group: LabelManagementRow[];
  usedColors: { personal: string[]; group: string[] };
}> {
  const user = await requireUser();

  return withUserDb(async (tx) => {
    const group = await callerGroupInfo(tx, user.id);
    const own = { ownerUserId: user.id };
    const empty = Promise.resolve([]);

    const [personal, personalColors, groupLabels, groupColors] = await Promise.all([
      listManagedLabels(own, tx),
      listUsedLabelColors(own, tx),
      group ? listManagedLabels({ groupId: group.id }, tx) : empty,
      group ? listUsedLabelColors({ groupId: group.id }, tx) : empty,
    ]);

    return {
      groupName: group?.name ?? null,
      isLeader: group?.role === "leader",
      personal,
      group: groupLabels,
      usedColors: { personal: personalColors, group: groupColors },
    };
  });
}
