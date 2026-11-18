"use server";

import { refresh } from "next/cache";

import {
  acceptDeliveries,
  acceptDelivery,
  chooseDeliveryAccounts,
  DeliveryNotPending,
  forgetMerchant,
  rejectDelivery,
  restoreShape,
  ShapeNotSilenced,
} from "@/db/queries/ingest-review";
import type { AcceptDeliveryArgs } from "@/db/queries/ingest-review";
import type { TransactionSplitInput } from "@/db/queries/transactions";
import { pgErrorCode, pgErrorMentions } from "@/lib/db-error";
import { ActionError } from "@/lib/errors";
import { toCents } from "@/lib/money";
import { authActionClient } from "@/lib/safe-action";
import {
  acceptDeliveriesSchema,
  acceptDeliverySchema,
  chooseDeliveryAccountsSchema,
  forgetMerchantSchema,
  rejectDeliverySchema,
  restoreShapeSchema,
} from "@/lib/validation/ingest";
import type { AcceptDeliveryInput } from "@/lib/validation/ingest";
import { type SplitFields, withPerson } from "@/lib/validation/transaction";

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
  // The split trigger's refusal of a category of the other kind than the movement (RF-278): said in plain words.
  if (code === "23514" && pgErrorMentions(error, "must share the movement's kind")) {
    throw new ActionError("ingest.errors.categoryKind");
  }
  throw error;
}

function toAcceptArgs(input: AcceptDeliveryInput): AcceptDeliveryArgs {
  return {
    deliveryId: input.deliveryId,
    fromAccountId: input.fromAccountId,
    toAccountId: input.toAccountId,
    amountCents: toCents(input.amount),
    occurredAt: input.occurredAt,
    description: input.description,
    splits: toSplitCents(input.splits),
    labelIds: withPerson(input.labelIds, input.forPersonId),
    contributedByMemberId: input.contributedByMemberId ?? null,
    madeByMemberId: input.madeByMemberId ?? null,
  };
}

export const acceptDeliveryAction = authActionClient
  .inputSchema(acceptDeliverySchema)
  .action(async ({ parsedInput }) => {
    let transactionId: string;
    try {
      ({ transactionId } = await acceptDelivery(toAcceptArgs(parsedInput)));
    } catch (error) {
      mapReviewError(error);
    }

    refresh();
    return { transactionId };
  });

export const acceptDeliveriesAction = authActionClient
  .inputSchema(acceptDeliveriesSchema)
  .action(async ({ parsedInput }) => {
    let transactionIds: string[];
    try {
      transactionIds = await acceptDeliveries(parsedInput.items.map(toAcceptArgs));
    } catch (error) {
      mapReviewError(error);
    }

    refresh();
    return { count: transactionIds.length };
  });

export const chooseDeliveryAccountsAction = authActionClient
  .inputSchema(chooseDeliveryAccountsSchema)
  .action(async ({ parsedInput }) => {
    try {
      await chooseDeliveryAccounts(parsedInput);
    } catch (error) {
      mapReviewError(error);
    }
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
    if (!(await forgetMerchant(merchantId))) throw new ActionError("errors.notFound");

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
