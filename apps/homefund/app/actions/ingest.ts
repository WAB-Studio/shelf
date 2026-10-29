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
import { parseAmount } from "@/lib/money";
import { authActionClient } from "@/lib/safe-action";
import {
  acceptDeliverySchema,
  forgetMerchantSchema,
  rejectDeliverySchema,
  restoreShapeSchema,
} from "@/lib/validation/ingest";

type SplitInput = { categoryId: string; amount: string };

// The amount and each split arrive as Zod-validated strings, already bound to
// the stored scale by the schema (RF-128); turning them into integers here can
// only fail if the schema let something through it should not have, so a null
// parse is `errors.unexpected`, not a field message.
function toCents(amount: string): number {
  const cents = parseAmount(amount);
  if (cents === null) throw new ActionError("errors.unexpected");
  return cents;
}

function toSplitCents(splits: SplitInput[]): TransactionSplitInput[] {
  return splits.map((split) => ({
    categoryId: split.categoryId,
    amountCents: toCents(split.amount),
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
