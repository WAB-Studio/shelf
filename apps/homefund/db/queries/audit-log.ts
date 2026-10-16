import "server-only";

import { and, asc, desc, eq, isNull, sql } from "drizzle-orm";
import type { SQL } from "drizzle-orm";

import { listCallerMembers } from "@/db/queries/group-members";
import { auditLog } from "@/db/schema";
import type { AuditLog } from "@/db/schema";
import { requireUser, withUserDb } from "@/db/session";
import { TIME_ZONE } from "@/lib/locales";

// The range bounds arrive as civil dates and compare against the row's Bogotá
// calendar day, so a full day is included at either end (RNF-06). A `null` actor
// filters the system writes; `undefined` drops the predicate entirely.
export type AuditLogFilters = {
  entity?: string;
  actorUserId?: string | null;
  from?: Date | string;
  to?: Date | string;
  limit: number;
  offset: number;
};

// What the viewer renders, and all it is handed: the `before_data`/`after_data`
// snapshots stay in the table, where a token hash or a bank message never reaches
// a client bundle (RNF-13).
export type AuditLogRow = Pick<
  AuditLog,
  "id" | "entity" | "recordId" | "action" | "actorUserId" | "occurredAt"
>;

// The entities the caller can actually read, and the actors to name a row by.
export type AuditFilterOptions = {
  entities: string[];
  actors: { userId: string; name: string }[];
};

// A Date bound reads back as its own Bogotá day; a string is already a civil date.
function toCivilDate(value: Date | string): string {
  if (typeof value === "string") return value;
  return new Intl.DateTimeFormat("en-CA", { timeZone: TIME_ZONE }).format(value);
}

function auditConditions(filters: AuditLogFilters): SQL[] {
  const conditions: SQL[] = [];

  if (filters.entity) conditions.push(eq(auditLog.entity, filters.entity));

  if (filters.actorUserId === null) {
    conditions.push(isNull(auditLog.actorUserId));
  } else if (filters.actorUserId) {
    conditions.push(eq(auditLog.actorUserId, filters.actorUserId));
  }

  // The Bogotá calendar day of the row, compared against the civil-date bounds.
  const bogotaDay = sql`(${auditLog.occurredAt} at time zone ${TIME_ZONE})::date`;
  if (filters.from) conditions.push(sql`${bogotaDay} >= ${toCivilDate(filters.from)}`);
  if (filters.to) conditions.push(sql`${bogotaDay} <= ${toCivilDate(filters.to)}`);

  return conditions;
}

/**
 * One page of the audit trail and its total, in ONE round trip (RF-53): the total
 * rides on the row query as a window over the same predicate, so counting costs
 * no transaction of its own. The SELECT policy bounds every row to the caller's
 * own, group and self-caused scope; the filters narrow that set further. Newest
 * first, `id` breaking ties within a shared timestamp.
 *
 * An offset past the last page returns no rows and so no total — an empty page
 * reads as empty, which is what it is.
 */
export async function listAuditLog(
  filters: AuditLogFilters,
): Promise<{ rows: AuditLogRow[]; total: number }> {
  const conditions = auditConditions(filters);
  const where = conditions.length > 0 ? and(...conditions) : undefined;

  return withUserDb(async (tx) => {
    const rows = await tx
      // The six columns the viewer renders and no more: `before_data`/`after_data`
      // hold whole rows, a token hash or a bank message among them (RNF-13). The
      // row nests under a key of its own so the window column never has to be
      // stripped back off it, and the cast is not decoration: a bigint arrives
      // from the driver as a string, and the pager counts pages with it.
      .select({
        row: {
          id: auditLog.id,
          entity: auditLog.entity,
          recordId: auditLog.recordId,
          action: auditLog.action,
          actorUserId: auditLog.actorUserId,
          occurredAt: auditLog.occurredAt,
        },
        total: sql<number>`(count(*) over ())::int`,
      })
      .from(auditLog)
      .where(where)
      .orderBy(desc(auditLog.occurredAt), desc(auditLog.id))
      .limit(filters.limit)
      .offset(filters.offset);

    return { rows: rows.map((row) => row.row), total: rows[0]?.total ?? 0 };
  });
}

// The distinct entities present among the rows the caller may read, ordered for a
// stable Select. An entity absent from the log never offers an empty filter.
async function listAuditEntities(): Promise<string[]> {
  return withUserDb(async (tx) => {
    const rows = await tx
      .selectDistinct({ entity: auditLog.entity })
      .from(auditLog)
      .orderBy(asc(auditLog.entity));

    return rows.map((row) => row.entity);
  });
}

/**
 * The filter option lists for the viewer, fanned in one pass (RF-53). Entities
 * come from the log itself; actors from the group roster — archived members
 * included, since a row outlives the member who caused it — plus the caller, who
 * reads under their own email when they name no member. Nothing is chained ahead
 * of the fan-out: the roster read resolves the group in its own statement.
 */
export async function getAuditFilterOptions(): Promise<AuditFilterOptions> {
  const user = await requireUser();

  const [entities, members] = await Promise.all([
    listAuditEntities(),
    listCallerMembers(user.id, { archived: "all" }),
  ]);

  const names = new Map<string, string>();
  for (const member of members) {
    if (member.userId) names.set(member.userId, member.name);
  }
  if (!names.has(user.id)) names.set(user.id, user.email);

  return {
    entities,
    actors: [...names].map(([userId, name]) => ({ userId, name })),
  };
}
