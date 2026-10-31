import "server-only";

import { and, asc, eq, isNotNull, lte, sql } from "drizzle-orm";

import { accounts, plannedPayments } from "@/db/schema";
import { settledIn } from "@/db/queries/planned-payments";
import { withUserDb } from "@/db/session";
import { todayInBogota } from "@/lib/dates";

export type DueReminder = {
  id: string;
  description: string | null;
  amountCents: number;
  currency: string;
  dueDate: string;
};

// Pending payments whose «Recordarme el» date has come (RF-159), oldest due first,
// at most `limit` of them, plus how many there are in all. One round trip: the
// total rides each row as a window count, and no row means none due.
export async function listDueReminders(
  limit: number,
): Promise<{ rows: DueReminder[]; total: number }> {
  const today = todayInBogota();
  const found = await withUserDb(async (tx) =>
    tx
      .select({
        id: plannedPayments.id,
        description: plannedPayments.description,
        amountCents: plannedPayments.amountCents,
        currency: settledIn,
        dueDate: plannedPayments.dueDate,
        total: sql<number>`(count(*) over ())::int`,
      })
      .from(plannedPayments)
      .leftJoin(
        sql`${accounts} from_account`,
        sql`from_account.id = ${plannedPayments.fromAccountId}`,
      )
      .leftJoin(
        sql`${accounts} to_account`,
        sql`to_account.id = ${plannedPayments.toAccountId}`,
      )
      .where(
        and(
          eq(plannedPayments.status, "pending"),
          isNotNull(plannedPayments.remindOn),
          lte(plannedPayments.remindOn, today),
        ),
      )
      .orderBy(asc(plannedPayments.dueDate), asc(plannedPayments.id))
      .limit(limit),
  );
  return {
    rows: found.map((row) => ({
      id: row.id,
      description: row.description,
      amountCents: row.amountCents,
      currency: row.currency,
      dueDate: row.dueDate,
    })),
    total: found[0]?.total ?? 0,
  };
}
