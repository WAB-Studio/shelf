import "server-only";

import { and, asc, desc, eq, sql } from "drizzle-orm";

import { insertTransaction } from "@/db/queries/transactions";
import type { CreateTransactionArgs } from "@/db/queries/transactions";
import {
  ingestDeliveries,
  ingestMerchants,
  ingestShapes,
} from "@/db/schema";
import { withUserDb } from "@/db/session";

export type PendingDeliveryRow = {
  id: string;
  rawText: string;
  externalRef: string;
  merchantId: string | null;
  merchantKey: string | null;
  merchantLabel: string | null;
  merchantState: "learning" | "trusted" | "ambiguous" | null;
  proposedAmountCents: number | null;
  proposedAccountId: string | null;
  proposedCategoryId: string | null;
  categorySource: "merchant" | "interpreter" | "credential_default" | null;
  proposedDirection: "income" | "expense" | null;
  proposedOccurredAt: string | null;
  proposedDescription: string | null;
  isComplete: boolean;
  createdAt: Date;
};

export type SilencedShapeRow = {
  id: string;
  sampleText: string;
  createdAt: Date;
  // Deliveries this silence discarded on its own, waiting to come back.
  silencedCount: number;
};

export class DeliveryNotPending extends Error {
  constructor() {
    super("delivery_not_pending");
    this.name = "DeliveryNotPending";
  }
}

export class ShapeNotSilenced extends Error {
  constructor() {
    super("shape_not_silenced");
    this.name = "ShapeNotSilenced";
  }
}

export type AcceptDeliveryArgs = Omit<CreateTransactionArgs, "externalRef"> & {
  deliveryId: string;
};

export type RejectDeliveryArgs = {
  deliveryId: string;
  silenceShape: boolean;
};

function isComplete(
  row: Pick<
    PendingDeliveryRow,
    | "proposedAmountCents"
    | "proposedAccountId"
    | "proposedCategoryId"
    | "categorySource"
  >,
): boolean {
  return (
    row.proposedAmountCents !== null &&
    row.proposedAccountId !== null &&
    row.proposedCategoryId !== null &&
    (row.categorySource === "merchant" || row.categorySource === "interpreter")
  );
}

export async function listPendingDeliveries(): Promise<PendingDeliveryRow[]> {
  return withUserDb(async (tx) => {
    const rows = await tx
      .select({
        id: ingestDeliveries.id,
        rawText: ingestDeliveries.rawText,
        externalRef: ingestDeliveries.externalRef,
        merchantId: ingestMerchants.id,
        merchantKey: ingestDeliveries.merchantKey,
        merchantLabel: ingestDeliveries.merchantLabel,
        merchantState: ingestMerchants.state,
        proposedAmountCents: ingestDeliveries.proposedAmountCents,
        proposedAccountId: ingestDeliveries.proposedAccountId,
        proposedCategoryId: ingestDeliveries.proposedCategoryId,
        categorySource: ingestDeliveries.categorySource,
        proposedDirection: ingestDeliveries.proposedDirection,
        proposedOccurredAt: ingestDeliveries.proposedOccurredAt,
        proposedDescription: ingestDeliveries.proposedDescription,
        createdAt: ingestDeliveries.createdAt,
      })
      .from(ingestDeliveries)
      .leftJoin(
        ingestMerchants,
        and(
          eq(ingestMerchants.ownerUserId, ingestDeliveries.ownerUserId),
          eq(ingestMerchants.merchantKey, ingestDeliveries.merchantKey),
        ),
      )
      .where(eq(ingestDeliveries.status, "pending"))
      .orderBy(asc(ingestDeliveries.createdAt));

    return rows.map((row) => ({ ...row, isComplete: isComplete(row) }));
  });
}

export async function countPendingDeliveries(): Promise<number> {
  return withUserDb(async (tx) => {
    const [row] = await tx
      .select({ count: sql<number>`count(*)::int` })
      .from(ingestDeliveries)
      .where(eq(ingestDeliveries.status, "pending"));

    return row.count;
  });
}

export type OwnMerchantRow = {
  id: string;
  merchantKey: string;
  merchantLabel: string;
  state: "learning" | "trusted" | "ambiguous";
};

export async function listOwnMerchants(): Promise<OwnMerchantRow[]> {
  return withUserDb(async (tx) =>
    tx
      .select({
        id: ingestMerchants.id,
        merchantKey: ingestMerchants.merchantKey,
        merchantLabel: ingestMerchants.merchantLabel,
        state: ingestMerchants.state,
      })
      .from(ingestMerchants)
      .orderBy(asc(ingestMerchants.merchantLabel)),
  );
}

export async function acceptDelivery({
  deliveryId,
  fromAccountId,
  toAccountId,
  amountCents,
  occurredAt,
  description,
  splits,
  labelIds,
}: AcceptDeliveryArgs): Promise<{ transactionId: string }> {
  return withUserDb(async (tx) => {
    const [delivery] = await tx
      .select({
        externalRef: ingestDeliveries.externalRef,
        shapeHash: ingestDeliveries.shapeHash,
        rawText: ingestDeliveries.rawText,
        merchantKey: ingestDeliveries.merchantKey,
        merchantLabel: ingestDeliveries.merchantLabel,
      })
      .from(ingestDeliveries)
      .where(
        and(
          eq(ingestDeliveries.id, deliveryId),
          eq(ingestDeliveries.status, "pending"),
        ),
      )
      .for("update");

    if (!delivery) throw new DeliveryNotPending();

    const result = await insertTransaction(tx, {
      fromAccountId,
      toAccountId,
      amountCents,
      occurredAt,
      description,
      externalRef: delivery.externalRef,
      splits,
      labelIds,
    });

    const updated = await tx
      .update(ingestDeliveries)
      .set({
        status: "accepted",
        resolvedAt: sql`now()`,
        transactionId: result.transactionId,
      })
      .where(
        and(
          eq(ingestDeliveries.id, deliveryId),
          eq(ingestDeliveries.status, "pending"),
        ),
      )
      .returning({ id: ingestDeliveries.id });

    if (updated.length === 0) throw new DeliveryNotPending();

    await tx.execute(sql`
      insert into ingest_shapes (shape_hash, decision, sample_text)
      values (${delivery.shapeHash}, 'approved', ${delivery.rawText})
      on conflict (owner_user_id, shape_hash) do nothing
    `);

    if (delivery.merchantKey !== null && splits.length === 1) {
      await tx.execute(sql`
        select private.remember_ingest_merchant(
          ${delivery.merchantKey},
          ${delivery.merchantLabel},
          ${splits[0].categoryId}
        )
      `);
    }

    return result;
  });
}

export async function rejectDelivery({
  deliveryId,
  silenceShape,
}: RejectDeliveryArgs): Promise<void> {
  return withUserDb(async (tx) => {
    const [delivery] = await tx
      .update(ingestDeliveries)
      .set({ status: "rejected", resolvedAt: sql`now()` })
      .where(
        and(
          eq(ingestDeliveries.id, deliveryId),
          eq(ingestDeliveries.status, "pending"),
        ),
      )
      .returning({
        shapeHash: ingestDeliveries.shapeHash,
        rawText: ingestDeliveries.rawText,
      });

    if (!delivery) throw new DeliveryNotPending();
    if (!silenceShape) return;

    await tx.execute(sql`
      insert into ingest_shapes (shape_hash, decision, sample_text)
      values (${delivery.shapeHash}, 'rejected', ${delivery.rawText})
      on conflict (owner_user_id, shape_hash)
      do update set decision = 'rejected'
    `);
  });
}

/**
 * The shapes a person silenced, each with the count of deliveries that silence
 * discarded on its own (RF-99), in ONE round trip: the count rides as a
 * correlated subquery, never an N+1 follow-up. No owner predicate — the two
 * select policies are the scope, inside the subquery as well as outside it.
 */
export async function listSilencedShapes(): Promise<SilencedShapeRow[]> {
  // The outer reference is written qualified: drizzle renders an embedded column
  // bare inside a projection, and a bare `shape_hash` binds to the subquery's own
  // table, which turns the correlation into a constant and counts every delivery.
  const outerShapeHash = sql`"ingest_shapes"."shape_hash"`;

  const silencedCount = sql<number>`(
    select count(*)::int from ingest_deliveries d
    where d.shape_hash = ${outerShapeHash} and d.silenced_on_arrival
  )`;

  return withUserDb(async (tx) =>
    tx
      .select({
        id: ingestShapes.id,
        sampleText: ingestShapes.sampleText,
        createdAt: ingestShapes.createdAt,
        silencedCount,
      })
      .from(ingestShapes)
      .where(eq(ingestShapes.decision, "rejected"))
      .orderBy(desc(ingestShapes.createdAt)),
  );
}

/**
 * Undoes a silence (RF-99) in ONE statement, so the memory and the deliveries it
 * discarded move together or not at all. The memory is deleted rather than
 * approved: absent is the *never seen* state RF-92 routes back to `pending`, and
 * an `approved` row would record an acceptance this person never made.
 *
 * `d.silenced_on_arrival` is the whole promise: a rejection a person made is
 * never touched. Clearing that flag and `resolved_at` is not optional either —
 * `ingest_deliveries_silenced_only_when_rejected` and
 * `ingest_deliveries_resolved_at_matches_status` refuse the row otherwise.
 */
export async function restoreShape({
  shapeId,
}: {
  shapeId: string;
}): Promise<{ deliveriesRestored: number }> {
  return withUserDb(async (tx) => {
    // `decision = 'rejected'` keeps this path from silently dropping the
    // approval memory an acceptance wrote under the same id.
    const [row] = await tx.execute<{ shapes: number; deliveries: number }>(sql`
      with dropped as (
        delete from ingest_shapes
        where id = ${shapeId} and decision = 'rejected'
        returning shape_hash
      ),
      restored as (
        update ingest_deliveries d
           set status = 'pending', resolved_at = null, silenced_on_arrival = false
          from dropped
         where d.shape_hash = dropped.shape_hash
           and d.status = 'rejected'
           and d.silenced_on_arrival
        returning d.id
      )
      select (select count(*)::int from dropped)  as shapes,
             (select count(*)::int from restored) as deliveries
    `);

    if (row.shapes === 0) throw new ShapeNotSilenced();

    return { deliveriesRestored: row.deliveries };
  });
}
