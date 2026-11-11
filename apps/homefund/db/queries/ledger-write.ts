import "server-only";

import { z } from "zod";

import { createAccount } from "@/db/queries/accounts";
import { createCategory } from "@/db/queries/categories";
import type { CategoryScope } from "@/db/queries/categories";
import { getUserGroup } from "@/db/queries/groups";
import {
  createTransaction,
  deleteTransaction,
  getSettlementCurrencies,
  readContributorContext,
  ResendChangedError,
  updateTransaction,
} from "@/db/queries/transactions";
import type { TransactionSplitInput } from "@/db/queries/transactions";
import { BASE_CURRENCY, type CurrencyCode } from "@/lib/currency";
import { pgErrorCode } from "@/lib/db-error";
import { ActionError } from "@/lib/errors";
import { parseAmount } from "@/lib/money";
import type { CreateAccountInput } from "@/lib/validation/account";
import type { createCategoryInputSchema } from "@/lib/validation/category";
import {
  type CreateTransactionInput,
  foreignSettlementCurrency,
  refineContributor,
  refineSettlement,
  type SplitFields,
  type UpdateTransactionInput,
} from "@/lib/validation/transaction";

// The writes behind the forms' actions and behind `/mcp`: each takes input a Zod schema already
// parsed and throws an `ActionError` carrying a catalogue key, so both doors refuse in the same words.

// The amount and each split arrive as Zod-validated strings, already bound to
// the stored scale by the schema; turning them into integers here can only
// fail if the schema let something through it should not have, so a null
// parse is `errors.unexpected`, not a field message.
function toMinor(amount: string): number {
  const minor = parseAmount(amount);
  if (minor === null) throw new ActionError("errors.unexpected");
  return minor;
}

function toSplitMinor(splits: SplitFields[]): TransactionSplitInput[] {
  return splits.map((split) => ({
    categoryId: split.categoryId,
    amountCents: toMinor(split.amount),
    description: split.description,
  }));
}

// What a movement carries beside its own amount: the second figure, in the
// minor unit of the account that settles elsewhere, and the mark that says a
// statement has not confirmed it yet (RF-122, RF-123).
type CounterAmount = { counterAmountCents: number | null; counterIsEstimate: boolean };

/**
 * Reads the second amount in the currency the accounts declare, never the one
 * the payload claims. The read only happens when there is a second amount to
 * place: a movement in its account's own currency is the common case and pays
 * nothing for this. The rule that decides required-or-forbidden is the very
 * refinement the form runs, against the currencies read back here (RNF-10);
 * what it does not see — a foreign account whose second amount never arrived —
 * the `transactions_verify_currency` trigger refuses on its own.
 */
async function resolveCounterAmount(movement: {
  fromAccountId: string | null;
  toAccountId: string | null;
  currency?: CurrencyCode;
  counterAmount?: string | null;
  counterIsEstimate?: boolean;
}): Promise<CounterAmount> {
  const counter = movement.counterAmount?.trim() ? movement.counterAmount : null;
  if (counter === null) {
    return { counterAmountCents: null, counterIsEstimate: false };
  }

  const settlement = await getSettlementCurrencies(movement);
  const verdict = z
    .custom<typeof movement>()
    .superRefine(refineSettlement(settlement))
    .safeParse(movement);

  if (!verdict.success) throw new ActionError(verdict.error.issues[0].message);

  const foreign = foreignSettlementCurrency(
    movement.currency ?? BASE_CURRENCY,
    settlement,
  );
  if (foreign === null) throw new ActionError("errors.unexpected");

  return {
    counterAmountCents: toMinor(counter),
    counterIsEstimate: movement.counterIsEstimate ?? false,
  };
}

// «De quién» is required on an income into a fund account (RF-167). The rule is the
// refinement the form runs, against what the destination really is. An edit that sends
// nothing keeps who the movement already credits, so it is asked only when that is nobody.
async function assertContributorGiven(
  movement: {
    fromAccountId: string | null;
    toAccountId: string | null;
    contributedByMemberId?: string | null;
  },
  transactionId?: string,
): Promise<void> {
  if (movement.fromAccountId !== null || movement.toAccountId === null) return;

  const { intoFund, stored } = await readContributorContext({
    toAccountId: movement.toAccountId,
    transactionId,
  });
  const effective = {
    ...movement,
    contributedByMemberId:
      movement.contributedByMemberId === undefined ? stored : movement.contributedByMemberId,
  };
  const verdict = z
    .custom<typeof effective>()
    .superRefine(refineContributor(intoFund))
    .safeParse(effective);

  if (!verdict.success) throw new ActionError(verdict.error.issues[0].message);
}

// `transactions_verify_currency` raises this and nothing else does: a movement
// whose currency does not agree with the accounts it names (migration `0032`).
const CURRENCY_REFUSAL = "23901";

// The scope, `kind` and `created_by` are the DB's to set, so none travels in the
// payload. 23514 is left to what it has always meant here — the split, scope and
// placement triggers, and the column checks; a denied write raises 42501, which
// reads the same as a movement that was never there — an account deleted under
// the open form lands there, since the INSERT policy runs before any foreign key.
// What is left for 23503 is a reference the row names that vanished after it was
// picked.
export function mapTransactionError(error: unknown): never {
  if (error instanceof ResendChangedError) throw new ActionError("errors.resendChanged");
  const code = pgErrorCode(error);
  if (code === "42501") throw new ActionError("errors.notFound");
  if (code === CURRENCY_REFUSAL) {
    throw new ActionError("transactions.errors.currencyMismatch");
  }
  if (code === "23514") throw new ActionError("transactions.errors.splitsScopeViolation");
  if (code === "23503") throw new ActionError("errors.referenceGone");
  throw error;
}

/**
 * Records a movement (RF-17, RF-25). Which of the two accounts is null decides
 * the kind, which the DB generates; an income or expense carries splits summing
 * to its amount, a transfer none. A resent `requestRef` answers with the movement
 * the first copy booked, and books nothing.
 */
export async function bookMovement(
  input: CreateTransactionInput,
  alsoCheck: () => Promise<void> = async () => {},
): Promise<{ transactionId: string }> {
  const [, , counter] = await Promise.all([alsoCheck(), assertContributorGiven(input), resolveCounterAmount(input)]);

  try {
    return await createTransaction({
      fromAccountId: input.fromAccountId,
      toAccountId: input.toAccountId,
      amountCents: toMinor(input.amount),
      currency: input.currency ?? null,
      ...counter,
      amountFromWords: input.amountFromWords ?? false,
      forHousehold: input.forHousehold ?? false,
      contributedByMemberId: input.contributedByMemberId ?? null,
      occurredAt: input.occurredAt,
      description: input.description,
      externalRef: input.externalRef ?? null,
      requestRef: input.requestRef,
      splits: toSplitMinor(input.splits),
      labelIds: input.labelIds,
      causedByTransactionId: input.causedByTransactionId,
    });
  } catch (error) {
    return mapTransactionError(error);
  }
}

/**
 * Rewrites a movement's editable fields and replaces its splits and labels
 * (RF-24). A denied edit reports as no row, the same as a movement that was
 * never there, and one whose stamp someone else's save moved reports `errors.stale`.
 */
export async function reviseMovement(
  input: UpdateTransactionInput,
  alsoCheck: () => Promise<void> = async () => {},
): Promise<void> {
  // RF-156: an edit sent without the stamp its form loaded is stale, refused before any write.
  if (!input.expectedUpdatedAt) throw new ActionError("errors.stale");
  const [, , counter] = await Promise.all([
    alsoCheck(),
    assertContributorGiven(input, input.transactionId),
    resolveCounterAmount(input),
  ]);

  let updated: Awaited<ReturnType<typeof updateTransaction>>;
  try {
    updated = await updateTransaction({
      transactionId: input.transactionId,
      fromAccountId: input.fromAccountId,
      toAccountId: input.toAccountId,
      amountCents: toMinor(input.amount),
      currency: input.currency ?? null,
      ...counter,
      forHousehold: input.forHousehold,
      contributedByMemberId: input.contributedByMemberId,
      occurredAt: input.occurredAt,
      description: input.description,
      splits: toSplitMinor(input.splits),
      labelIds: input.labelIds,
      // Wholesale: an edit clearing the cause sends `null`, and absent means none.
      causedByTransactionId: input.causedByTransactionId ?? null,
      expectedUpdatedAt: input.expectedUpdatedAt,
    });
  } catch (error) {
    mapTransactionError(error);
  }

  if (updated === "adjustment") throw new ActionError("errors.adjustmentReadOnly");
  if (updated === "missing") throw new ActionError("errors.notFound");
  if (updated === "stale") throw new ActionError("errors.stale");
}

// The cascade removes the splits and label joins; a false row count is a denied
// or absent movement (RF-24).
export async function dropMovement(transactionId: string): Promise<void> {
  const deleted = await deleteTransaction({ transactionId });
  if (deleted === "adjustment") throw new ActionError("errors.adjustmentReadOnly");
  if (deleted === "missing") throw new ActionError("errors.notFound");
}

/**
 * Creates an account (RF-60, RF-09, RF-10, RF-121). A personal account is owned
 * by the caller; a group account is held by their group and shared so any member
 * may write it. The amount arrives as a string the schema already read in the
 * account's own currency; parsing it again here can only fail if the schema let
 * something through it should not have.
 */
export async function openAccount(
  { amount, placement, ...account }: CreateAccountInput,
  userId: string,
): Promise<{ accountId: string }> {
  const amountMinor = parseAmount(amount);
  if (amountMinor === null) throw new ActionError("errors.unexpected");

  // The owner/group XOR is resolved from the session, never trusted from the
  // form; a group placement without a group has nowhere to land.
  let placementFields: { ownerUserId: string | null; groupId: string | null; isShared: boolean };
  if (placement === "group") {
    const group = await getUserGroup();
    if (!group) throw new ActionError("errors.notFound");
    placementFields = { ownerUserId: null, groupId: group.id, isShared: true };
  } else {
    placementFields = { ownerUserId: userId, groupId: null, isShared: false };
  }

  try {
    return await createAccount({ ...account, ...placementFields, amountMinor });
  } catch (error) {
    // `accounts_settlement_currency_iso`: a code the picker does not offer and
    // the shape check refuses. Every other 23514 on this table is a placement
    // the form cannot express.
    if (pgErrorCode(error) === "23514") throw new ActionError("accounts.errors.currencyInvalid");
    // PK001: the parent is no live asset of this scope and currency (RF-173).
    if (pgErrorCode(error) === "PK001") throw new ActionError("accounts.errors.parentInvalid");
    throw error;
  }
}

// The trigger raises one code, 23514, for four refusals; three are
// nesting-shaped and the fourth, a kind mismatch, is the one the parent picker
// already prevents. A null parent leaves the trigger before it can raise at
// all, so that branch only guards against the trigger changing shape.
export function categoryConstraintErrorKey(parentId: string | null): string {
  return parentId ? "errors.categoryNesting" : "errors.categoryKindMismatch";
}

/**
 * Creates a category (RF-63, RF-27). Depth, kind agreement and same-scope
 * parentage are the trigger's and the composite foreign key's to enforce;
 * this only turns their shared refusal code into a sentence. The scope
 * is the caller's group when they belong to one, otherwise their personal set.
 */
export async function openCategory(
  { placement, ...input }: z.infer<typeof createCategoryInputSchema>,
  userId: string,
): Promise<{ categoryId: string }> {
  let scope: CategoryScope;
  if (placement === "personal") {
    scope = { ownerUserId: userId };
  } else {
    const group = await getUserGroup();
    if (placement === "group" && !group) throw new ActionError("errors.notFound");
    scope = group ? { groupId: group.id } : { ownerUserId: userId };
  }

  try {
    return await createCategory({ ...input, scope });
  } catch (error) {
    if (pgErrorCode(error) === "42501") throw new ActionError("errors.notLeader");
    if (pgErrorCode(error) === "23514") {
      throw new ActionError(categoryConstraintErrorKey(input.parentId));
    }
    throw error;
  }
}
