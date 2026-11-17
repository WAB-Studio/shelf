import "server-only";

import { and, asc, eq, inArray, isNull, sql } from "drizzle-orm";

import { internalAccountSql } from "@/db/queries/accounts";
import {
  accounts,
  categories,
  ingestDeliveries,
  ingestMerchants,
  recipients,
} from "@/db/schema";
import { learnedCategoryId } from "@/db/queries/learned-category";
import { withImpersonatedDb } from "@/db/session";
import { BASE_CURRENCY } from "@/lib/currency";
import { pgErrorCode } from "@/lib/db-error";
import { todayInBogota } from "@/lib/dates";
import type { EmailVerdict } from "@/lib/ingest/classify";
import { DUPLICATE_WINDOW_DAYS, judgeDuplicate, type DuplicateCandidate } from "@/lib/ingest/duplicates";
import { describeAlert, looksLikeBankAlert, onlyBankAccount, paidOwnCard } from "@/lib/ingest/describe";
import { emailDescription, emailMerchant } from "@/lib/ingest/email";
import { fingerprintMessage, merchantOf } from "@/lib/ingest/fingerprint";
import { applyRecipient, extractNumber, matchRecipient } from "@/lib/ingest/recipient-number";
import { parseAmount } from "@/lib/money";
import { interpretQuickEntry, readAccountTails } from "@/lib/transactions/interpret";
import type { WebhookPayloadInput } from "@/lib/validation/webhook";

export type IngestDeliveryResult = {
  deliveryId: string;
  status: "pending" | "rejected";
  duplicate: boolean;
  // Set when the delivery landed rejected because the payment it reports was already in the inbox (RF-208).
  reason?: "duplicate";
};

export type RecordIngestDeliveryArgs = {
  ownerUserId: string;
  credentialId: string;
  defaultAccountId: string | null;
  defaultCategoryId: string | null;
  payload: WebhookPayloadInput;
  // A bank email (RF-187) is judged before it lands: one that reports no movement is stored rejected, with
  // its reason and no figure (RF-196); the amount reading also drops a lone year.
  email?: EmailVerdict;
};

const MAX_DESCRIPTION_LENGTH = 200;
// A figure in dollars or euros is no peso figure (RF-207); the proposal waits for a person to state it.
const FOREIGN_CURRENCY = /\b(?:USD|EUR)\b|US\$/;

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

type Merchant = ReturnType<typeof merchantOf>;

// A delivery that repeats an alert still waiting gives it the business the alert did not name, so the
// person reads «CENS» where the bank said «a la cuenta *1234» (RF-208).
async function fillOriginal(
  tx: Parameters<Parameters<typeof withImpersonatedDb>[1]>[0],
  original: DuplicateCandidate,
  merchant: Merchant,
): Promise<void> {
  if (!merchant || original.receipt || original.status !== "pending" || original.merchantKey) return;

  await tx
    .update(ingestDeliveries)
    .set({ proposedDescription: merchant.label, merchantKey: merchant.key, merchantLabel: merchant.label })
    .where(
      and(
        eq(ingestDeliveries.id, original.id),
        eq(ingestDeliveries.status, "pending"),
        isNull(ingestDeliveries.merchantKey),
      ),
    );
}

export async function recordIngestDelivery({
  ownerUserId,
  credentialId,
  defaultAccountId,
  defaultCategoryId,
  payload,
  email,
}: RecordIngestDeliveryArgs): Promise<IngestDeliveryResult> {
  const fingerprint = fingerprintMessage(payload.text);
  const today = todayInBogota();
  const externalRef = payload.external_ref ?? fingerprint.contentHash;
  const extractedIdentifier = extractNumber(payload.text);
  const verdictReason = email && !email.movement ? email.reason : null;
  const receipt = email?.movement === true && email.receipt;

  // A receipt names its business in a field when no «en <comercio>» does (RF-208).
  const merchant = fingerprint.merchant ?? (receipt ? merchantOf(emailMerchant(payload.text) ?? "") : null);

  // The figure, the day and the direction a message reports do not depend on the person's accounts, so
  // the payment's original is looked up in the same round trip as the rest (RF-208).
  const read = interpretQuickEntry(payload.text, {
    categories: [],
    accounts: [],
    defaultAccountId: null,
    yearGuard: email ? "any" : "dated",
  });
  const proposedOccurredAt = resolveOccurredAt(payload.occurred_at, read.occurredAt, today);
  // Reads the same way the importer does (RF-128): thousands separators in either convention, an optional
  // zero-decimal suffix, up to the two decimals the column stores. A finer amount or a non-positive one is
  // dropped here, not rounded: the proposal is left without a figure rather than one nobody wrote. A figure in
  // dollars or euros is no peso figure either (RF-207).
  const rawPesos = payload.amount ?? read.amountPesos;
  const parsedAmountCents = rawPesos === null ? null : parseAmount(rawPesos);
  const readAmountCents =
    !(email && FOREIGN_CURRENCY.test(payload.text)) &&
    !(email?.movement && !email.priced) &&
    parsedAmountCents !== null &&
    parsedAmountCents > 0
      ? parsedAmountCents
      : null;

  return withImpersonatedDb(ownerUserId, async (tx) => {
    // Do not read ingest_shapes here; the insert trigger owns that decision.
    const [categoryRows, accountRows, merchantRows, recipientRows, originalRows] = await Promise.all([
      tx
        .select({ id: categories.id, name: categories.name, kind: categories.kind })
        .from(categories),
      tx
        .select({
          id: accounts.id,
          name: accounts.name,
          lastFour: accounts.lastFour,
          institution: accounts.institution,
          subtype: accounts.subtype,
          groupId: accounts.groupId,
          settlementCurrency: accounts.settlementCurrency,
        })
        .from(accounts)
        // A bank message never names a «Me debe» (RF-216).
        .where(and(isNull(accounts.archivedAt), sql`not ${internalAccountSql}`)),
      merchant
        ? tx
            .select({
              state: ingestMerchants.state,
              trustedCategoryId: ingestMerchants.trustedCategoryId,
            })
            .from(ingestMerchants)
            .where(eq(ingestMerchants.merchantKey, merchant.key))
            .limit(1)
        : Promise.resolve(null),
      extractedIdentifier
        ? tx
            .select({
              id: recipients.id,
              identifier: recipients.identifier,
              name: recipients.name,
              kind: recipients.kind,
              accountId: recipients.accountId,
              categoryId: recipients.categoryId,
            })
            .from(recipients)
            .where(sql`${recipients.identifier} like ${"%" + extractedIdentifier}`)
        : Promise.resolve([]),
      // What already reports this payment: the same figure (or, with no figure, the same business) within
      // two days, still waiting or already recorded (RF-208). Oldest first.
      (email === undefined || email.movement) && (readAmountCents !== null || merchant)
        ? tx
            .select({
              id: ingestDeliveries.id,
              status: ingestDeliveries.status,
              receipt: ingestDeliveries.receipt,
              fromEmail: ingestDeliveries.fromEmail,
              rawText: ingestDeliveries.rawText,
              occurredOn: ingestDeliveries.proposedOccurredAt,
              receivedAt: ingestDeliveries.createdAt,
              shapeHash: ingestDeliveries.shapeHash,
              direction: ingestDeliveries.proposedDirection,
              merchantKey: ingestDeliveries.merchantKey,
              merchantLabel: ingestDeliveries.merchantLabel,
            })
            .from(ingestDeliveries)
            .where(
              and(
                inArray(ingestDeliveries.status, ["pending", "accepted"]),
                isNull(ingestDeliveries.rejectReason),
                sql`${ingestDeliveries.proposedOccurredAt} between ${proposedOccurredAt}::date - ${DUPLICATE_WINDOW_DAYS}::int and ${proposedOccurredAt}::date + ${DUPLICATE_WINDOW_DAYS}::int`,
                readAmountCents !== null
                  ? eq(ingestDeliveries.proposedAmountCents, readAmountCents)
                  : eq(ingestDeliveries.merchantKey, merchant?.key ?? ""),
              ),
            )
            .orderBy(asc(ingestDeliveries.createdAt))
        : Promise.resolve([]),
    ]);

    const original = judgeDuplicate(
      {
        fromEmail: email !== undefined,
        text: payload.text,
        occurredOn: proposedOccurredAt,
        receivedAt: Date.now(),
        receipt,
        shapeHash: fingerprint.shapeHash,
        direction: payload.direction ?? read.direction,
      },
      originalRows.map(
        (row): DuplicateCandidate => ({
          ...row,
          receivedAt: row.receivedAt.getTime(),
          status: row.status === "accepted" ? "accepted" : "pending",
        }),
      ),
    );
    const rejectReason = verdictReason ?? (original.kind === "repeats" ? "duplicate" : null);
    const duplicateOfId = original.kind === "repeats" ? original.of.id : null;

    const proposal = interpretQuickEntry(payload.text, {
      categories: categoryRows,
      accounts: accountRows,
      defaultAccountId,
      yearGuard: email ? "any" : "dated",
    });

    const proposedAmountCents = rejectReason === null ? readAmountCents : null;

    const memory = merchantRows?.[0] ?? null;
    const trustedCategoryId = memory?.state === "trusted" ? memory.trustedCategoryId : null;
    const recipient = matchRecipient(extractedIdentifier, recipientRows);

    let proposedCategoryId =
      trustedCategoryId ?? proposal.categoryId ?? defaultCategoryId ?? null;
    let categorySource: "merchant" | "interpreter" | "credential_default" | "recipient" | null =
      trustedCategoryId
        ? "merchant"
        : proposal.categoryId
          ? "interpreter"
          : defaultCategoryId
            ? "credential_default"
            : null;

    // A bank alert's remainder carries its label, date, identifiers and help line, whichever channel brought
    // it (SMS, notification, shortcut or email): what it says happened is the description (RF-206).
    let description = (
      describeAlert(payload.text) ??
      (email || looksLikeBankAlert(payload.text) ? emailDescription(proposal.description) : proposal.description)
    )
      .trim()
      .slice(0, MAX_DESCRIPTION_LENGTH);

    // An alert that names no account tail belongs to the person's only account at that bank.
    let proposedAccountId =
      payload.account_id ??
      proposal.accountId ??
      (readAccountTails(payload.text, payload.direction ?? proposal.direction).size === 0
        ? onlyBankAccount(payload.text, accountRows)
        : null);
    let proposedToAccountId: string | null = null;
    let proposedDirection: "income" | "expense" | "transfer" | null =
      payload.direction ?? proposal.direction;

    // A saved number says what the message could not (RF-189): its name is the description, and its kind
    // decides the shape. The delivery still waits for a person.
    if (recipient) {
      const applied = applyRecipient(
        { direction: payload.direction ?? proposal.direction, accountId: proposedAccountId },
        recipient,
      );
      description = applied.description;
      proposedDirection = applied.direction;
      proposedAccountId = applied.accountId;
      proposedToAccountId = applied.toAccountId;
      if (applied.direction === "transfer") {
        proposedCategoryId = null;
        categorySource = null;
      } else if (applied.categoryId) {
        proposedCategoryId = applied.categoryId;
        categorySource = "recipient";
      }
    }
    // A payment to the institution of exactly one of the person's cards or loans pays that card: a transfer.
    if (!recipient && proposedDirection === "expense") {
      const card = paidOwnCard(payload.text, accountRows);
      if (card !== null && card !== proposedAccountId) {
        proposedDirection = "transfer";
        proposedToAccountId = card;
        proposedCategoryId = null;
        categorySource = null;
      }
    }
    // A delivery that names an account settling outside BASE_CURRENCY is
    // forced rejected below (errors.foreignCurrencyUnsupported): `pesos`
    // above read the amount as pesos, which only that settlement makes true.
    const proposedAccount = accountRows.find((row) => row.id === proposedAccountId);
    const foreignCurrencyAccount =
      proposedAccount !== undefined && proposedAccount.settlementCurrency !== BASE_CURRENCY;
    // An alert that names no business takes it from a receipt it replaces (RF-208).
    const donor =
      original.kind === "supersedes" && !merchant
        ? original.pending.find((row) => row.merchantKey && row.merchantLabel)
        : undefined;
    if (donor?.merchantLabel) description = donor.merchantLabel;
    const proposedDescription = description === "" ? null : description;

    // What the proposal would otherwise fall back on (the key's default, or nothing) gives way to what the
    // person's own movements of this counterparty agree on (RF-210). A category the message named, a trusted
    // merchant or a saved recipient already speak for the person and are left alone. It rides the delivery's
    // own transaction, once, and only for a proposal that has no category of its own yet.
    if (
      rejectReason === null &&
      proposedDirection !== "transfer" &&
      (categorySource === null || categorySource === "credential_default")
    ) {
      // A saved recipient's name, or the merchant the message carried, names the counterparty; the
      // description of a message that carried one is the message itself, and names no one.
      const merchantLabel = recipient === null ? (fingerprint.merchant?.label ?? null) : null;
      const learned = await learnedCategoryId(tx, {
        merchantLabel,
        description: merchantLabel === null ? proposedDescription : null,
        kind: proposedDirection === "income" ? "income" : "expense",
        groupId: proposedAccount ? proposedAccount.groupId : undefined,
        today,
      });
      if (learned !== null) {
        proposedCategoryId = learned;
        categorySource = "merchant";
      }
    }
    const merchantKey = merchant?.key ?? donor?.merchantKey ?? null;
    const merchantLabel = merchant?.label ?? donor?.merchantLabel ?? null;

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
            proposed_description,
            proposed_to_account_id,
            extracted_identifier,
            recipient_id,
            reject_reason,
            receipt,
            from_email,
            duplicate_of_id
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
            ${proposedDescription},
            ${proposedToAccountId},
            ${extractedIdentifier},
            ${recipient?.id ?? null},
            ${rejectReason},
            ${receipt},
            ${email !== undefined},
            ${duplicateOfId}
          )
          returning id, status
        `),
      );

      // The insert trigger only reads the shape memory (RF-92); a currency
      // mismatch is this module's own reason to reject, applied after — never
      // silently, and never turned into a movement either way (RF-90).
      if ((foreignCurrencyAccount || rejectReason !== null) && row.status === "pending") {
        await tx.execute(sql`
          update ingest_deliveries
          set status = 'rejected', resolved_at = now()
          where id = ${row.id} and status = 'pending'
        `);
        if (original.kind === "repeats" && rejectReason === "duplicate") {
          await fillOriginal(tx, original.of, merchant);
        }
        return {
          deliveryId: row.id,
          status: "rejected",
          duplicate: false,
          ...(rejectReason === "duplicate" ? { reason: "duplicate" as const } : {}),
        };
      }

      // The receipts that were waiting for their alert become its repeats (RF-208).
      if (original.kind === "supersedes" && row.status === "pending") {
        await tx
          .update(ingestDeliveries)
          .set({ status: "rejected", resolvedAt: sql`now()`, rejectReason: "duplicate", duplicateOfId: row.id })
          .where(
            and(
              inArray(
                ingestDeliveries.id,
                original.pending.map((pending) => pending.id),
              ),
              eq(ingestDeliveries.status, "pending"),
            ),
          );
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
