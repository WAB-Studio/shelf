"use server";

import { eq } from "drizzle-orm";
import { refresh } from "next/cache";

import {
  acceptDelivery,
  DeliveryNotPending,
  rejectDelivery,
  restoreShape,
  ShapeNotSilenced,
} from "@/db/queries/ingest-review";
import type { TransactionSplitInput } from "@/db/queries/transactions";
import { ingestMerchants } from "@/db/schema";
import { withUserDb } from "@/db/session";
import { pgErrorCode } from "@/lib/db-error";
import { ActionError } from "@/lib/errors";
import { toCents } from "@/lib/money";
import { authActionClient } from "@/lib/safe-action";
import {
  acceptDeliverySchema,
  forgetMerchantSchema,
  rejectDeliverySchema,
  restoreShapeSchema,
} from "@/lib/validation/ingest";
import type { SplitFields } from "@/lib/validation/transaction";

function toSplitCents(splits: SplitFields[]): TransactionSplitInput[] {
  return splits.map((split) => ({
    categoryId: split.categoryId,
    amountCents: toCents(split.amount),
    description: split.description,
  }));
}

function mapReviewError(error: unknown): never {
  if (error instanceof DeliveryNotPending || error instanceof ShapeNotSilenced) {
    throw new ActionError("errors.notFound");
  }

  const code = pgErrorCode(error);
  if (code === "42501" || code === "23503") {
    throw new ActionError("errors.notFound");
  }
  throw error;
}

export const acceptDeliveryAction = authActionClient
  .inputSchema(acceptDeliverySchema)
  .action(async ({ parsedInput }) => {
    const amountCents = toCents(parsedInput.amount);
    const splits = toSplitCents(parsedInput.splits);

    let transactionId: string;
    try {
      ({ transactionId } = await acceptDelivery({
        deliveryId: parsedInput.deliveryId,
        fromAccountId: parsedInput.fromAccountId,
        toAccountId: parsedInput.toAccountId,
        amountCents,
        occurredAt: parsedInput.occurredAt,
        description: parsedInput.description,
        splits,
        labelIds: parsedInput.labelIds,
        contributedByMemberId: parsedInput.contributedByMemberId ?? null,
      }));
    } catch (error) {
      mapReviewError(error);
    }

    refresh();
    return { transactionId };
  });

export const rejectDeliveryAction = authActionClient
  .inputSchema(rejectDeliverySchema)
  .action(async ({ parsedInput }) => {
    try {
      await rejectDelivery(parsedInput);
    } catch (error) {
      mapReviewError(error);
    }

    refresh();
  });

export const forgetMerchantAction = authActionClient
  .inputSchema(forgetMerchantSchema)
  .action(async ({ parsedInput: { merchantId } }) => {
    const deleted = await withUserDb((tx) =>
      tx
        .delete(ingestMerchants)
        .where(eq(ingestMerchants.id, merchantId))
        .returning({ id: ingestMerchants.id }),
    );

    if (deleted.length === 0) throw new ActionError("errors.notFound");

    refresh();
  });

export const restoreShapeAction = authActionClient
  .inputSchema(restoreShapeSchema)
  .action(async ({ parsedInput }) => {
    let deliveriesRestored: number;
    try {
      ({ deliveriesRestored } = await restoreShape(parsedInput));
    } catch (error) {
      mapReviewError(error);
    }

    refresh();
    // The count travels back so the toast can name what returned to the queue.
    return { deliveriesRestored };
  });
