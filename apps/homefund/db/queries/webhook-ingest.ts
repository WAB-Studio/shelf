import "server-only";

import { and, eq, isNull, sql } from "drizzle-orm";

import {
  accounts,
  categories,
  ingestDeliveries,
  ingestMerchants,
} from "@/db/schema";
import { withImpersonatedDb } from "@/db/session";
import { BASE_CURRENCY } from "@/lib/currency";
import { pgErrorCode } from "@/lib/db-error";
import { todayInBogota } from "@/lib/dates";
import { fingerprintMessage } from "@/lib/ingest/fingerprint";
import { parseAmount } from "@/lib/money";
import { interpretQuickEntry } from "@/lib/transactions/interpret";
import type { WebhookPayloadInput } from "@/lib/validation/webhook";

export type IngestDeliveryResult = {
  deliveryId: string;
  status: "pending" | "rejected";
  duplicate: boolean;
};

export type RecordIngestDeliveryArgs = {
  ownerUserId: string;
  credentialId: string;
  defaultAccountId: string | null;
  defaultCategoryId: string | null;
  payload: WebhookPayloadInput;
};

const MAX_DESCRIPTION_LENGTH = 200;

// The one place the date's precedence lives: the caller's override, then the
// day the message names, then the day it was delivered. A read date later than
// the delivery day counts as unreadable — `occurredAtSchema` rejects a future
// date on the accept path, and a proposal nobody can accept in one tap is worse
// than one dated today. `YYYY-MM-DD` sorts as it reads, so no `Date` is built.
export function resolveOccurredAt(
  supplied: string | undefined,
  read: string | null,
  today: string,
): string {
  if (supplied) return supplied;

  return read !== null && read <= today ? read : today;
}

export async function recordIngestDelivery({
  ownerUserId,
  credentialId,
  defaultAccountId,
  defaultCategoryId,
  payload,
}: RecordIngestDeliveryArgs): Promise<IngestDeliveryResult> {
  const fingerprint = fingerprintMessage(payload.text);
  const today = todayInBogota();
  const externalRef = payload.external_ref ?? fingerprint.contentHash;

  return withImpersonatedDb(ownerUserId, async (tx) => {
    // Do not read ingest_shapes here; the insert trigger owns that decision.
    const [categoryRows, accountRows, merchantRows] = await Promise.all([
      tx
        .select({ id: categories.id, name: categories.name, kind: categories.kind })
        .from(categories),
      tx
        .select({
          id: accounts.id,
          name: accounts.name,
          lastFour: accounts.lastFour,
          settlementCurrency: accounts.settlementCurrency,
        })
        .from(accounts)
        .where(isNull(accounts.archivedAt)),
      fingerprint.merchant
        ? tx
            .select({
              state: ingestMerchants.state,
              trustedCategoryId: ingestMerchants.trustedCategoryId,
            })
            .from(ingestMerchants)
            .where(eq(ingestMerchants.merchantKey, fingerprint.merchant.key))
            .limit(1)
        : Promise.resolve(null),
    ]);

    const proposal = interpretQuickEntry(payload.text, {
      categories: categoryRows,
      accounts: accountRows,
      defaultAccountId,
    });

    // Reads the same way the importer does (RF-128): thousands separators in
    // either convention, an optional zero-decimal suffix, up to the two
    // decimals the column stores. A finer amount or a non-positive one is
    // dropped here, not rounded — the proposal is left without a figure
    // rather than one nobody wrote.
    const rawPesos = payload.amount ?? proposal.amountPesos;
    const parsedAmountCents = rawPesos === null ? null : parseAmount(rawPesos);
    const proposedAmountCents =
      parsedAmountCents !== null && parsedAmountCents > 0 ? parsedAmountCents : null;

    const merchant = merchantRows?.[0] ?? null;
    const trustedCategoryId =
      merchant?.state === "trusted" ? merchant.trustedCategoryId : null;
    const proposedCategoryId =
      trustedCategoryId ?? proposal.categoryId ?? defaultCategoryId ?? null;
    const categorySource = trustedCategoryId
      ? ("merchant" as const)
      : proposal.categoryId
        ? ("interpreter" as const)
        : defaultCategoryId
          ? ("credential_default" as const)
          : null;

    const description = proposal.description.trim().slice(0, MAX_DESCRIPTION_LENGTH);

    const proposedAccountId = payload.account_id ?? proposal.accountId;
    // A delivery that names an account settling outside BASE_CURRENCY is
    // forced rejected below (errors.foreignCurrencyUnsupported): `pesos`
    // above read the amount as pesos, which only that settlement makes true.
    const proposedAccount = accountRows.find((row) => row.id === proposedAccountId);
    const foreignCurrencyAccount =
      proposedAccount !== undefined && proposedAccount.settlementCurrency !== BASE_CURRENCY;
    const proposedDirection = payload.direction ?? proposal.direction;
    const proposedOccurredAt = resolveOccurredAt(
      payload.occurred_at,
      proposal.occurredAt,
      today,
    );
    const proposedDescription = description === "" ? null : description;
    const merchantKey = fingerprint.merchant?.key ?? null;
    const merchantLabel = fingerprint.merchant?.label ?? null;

    try {
      // Keep a duplicate from aborting the transaction before its read-back.
      const [row] = await tx.transaction((sp) =>
        sp.execute<{ id: string; status: "pending" | "rejected" }>(sql`
          insert into ingest_deliveries (
            credential_id,
            external_ref,
            raw_text,
            shape_hash,
            merchant_key,
            merchant_label,
            proposed_amount_cents,
            proposed_account_id,
            proposed_category_id,
            category_source,
            proposed_direction,
            proposed_occurred_at,
            proposed_description
          ) values (
            ${credentialId},
            ${externalRef},
            ${payload.text},
            ${fingerprint.shapeHash},
            ${merchantKey},
            ${merchantLabel},
            ${proposedAmountCents},
            ${proposedAccountId},
            ${proposedCategoryId},
            ${categorySource},
            ${proposedDirection},
            ${proposedOccurredAt},
            ${proposedDescription}
          )
          returning id, status
        `),
      );

      // The insert trigger only reads the shape memory (RF-92); a currency
      // mismatch is this module's own reason to reject, applied after — never
      // silently, and never turned into a movement either way (RF-90).
      if (foreignCurrencyAccount && row.status === "pending") {
        await tx.execute(sql`
          update ingest_deliveries
          set status = 'rejected', resolved_at = now()
          where id = ${row.id} and status = 'pending'
        `);
        return { deliveryId: row.id, status: "rejected", duplicate: false };
      }

      return {
        deliveryId: row.id,
        status: row.status,
        duplicate: false,
      };
    } catch (error) {
      if (pgErrorCode(error) !== "23505") throw error;

      const [existing] = await tx
        .select({ id: ingestDeliveries.id, status: ingestDeliveries.status })
        .from(ingestDeliveries)
        .where(
          and(
            eq(ingestDeliveries.ownerUserId, ownerUserId),
            eq(ingestDeliveries.externalRef, externalRef),
          ),
        )
        .limit(1);

      if (!existing) throw error;

      return {
        deliveryId: existing.id,
        status: existing.status as IngestDeliveryResult["status"],
        duplicate: true,
      };
    }
  });
}
