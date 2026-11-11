import "server-only";

import type { CallToolResult, McpServer, ServerContext } from "@modelcontextprotocol/server";
import { z } from "zod";

import { listAccountNames, type AccountNameRow } from "@/db/queries/accounts";
import { listScopedCategories, type ScopedCategoryNode } from "@/db/queries/categories";
import {
  acceptDelivery,
  DeliveryNotPending,
  listDeliveries,
  rejectDelivery,
  type PendingDeliveryRow,
} from "@/db/queries/ingest-review";
import { assertContributorGiven, mapTransactionError } from "@/db/queries/ledger-write";
import { withSharedTransaction, withUserDb } from "@/db/session";
import { todayInBogota } from "@/lib/dates";
import { ActionError } from "@/lib/errors";
import { categoryNamesById, categoryPathsById } from "@/lib/fund/category-names";
import { proposedCategoryId } from "@/lib/fund/category-scope";
import { centsToDecimal, toCents } from "@/lib/money";
import { pgErrorCode } from "@/lib/db-error";
import { acceptDeliverySchema } from "@/lib/validation/ingest";

type Say = (key: string) => string;
type Run = (ctx: ServerContext, load: (owner: string) => Promise<unknown>) => Promise<CallToolResult>;

// A batch refused whole: the sentence is a catalogue key, `deliveryId` names the item that stopped it
// and `field` the missing one, so Claude can fill it in and call again.
export class BatchRefusal extends Error {
  constructor(
    readonly messageKey: string,
    readonly deliveryId: string,
    readonly field?: string,
  ) {
    super(messageKey);
  }
}

const KINDS = ["expense", "income", "transfer"] as const;

const acceptItem = z.object({
  id: z.string(),
  kind: z.enum(KINDS).optional(),
  accountId: z.string().optional(),
  fromAccountId: z.string().optional(),
  toAccountId: z.string().optional(),
  amountCents: z.number().int().optional(),
  categoryId: z.string().optional(),
  splits: z
    .array(z.object({ categoryId: z.string(), amountCents: z.number().int(), description: z.string().nullish() }))
    .optional(),
  description: z.string().nullable().optional(),
  date: z.string().optional(),
  contributedByMemberId: z.string().nullish(),
  madeByMemberId: z.string().nullish(),
});

type AcceptItem = z.infer<typeof acceptItem>;

// What the tools need to read a proposal as the screen does: every account by id, archived ones too,
// and the categories with their scope.
type Lookup = { accounts: Map<string, AccountNameRow>; categories: ScopedCategoryNode[] };

async function readLookup(owner: string): Promise<Lookup> {
  const [accounts, categories] = await Promise.all([listAccountNames(), listScopedCategories(owner)]);
  return { accounts: new Map(accounts.map((account) => [account.id, account])), categories };
}

// The proposed account when it can still take a movement: an archived one reads as none.
function usableAccount(delivery: PendingDeliveryRow, lookup: Lookup): string | null {
  const account = delivery.proposedAccountId === null ? undefined : lookup.accounts.get(delivery.proposedAccountId);
  return account && !account.archived ? account.id : null;
}

// Read exactly as the card reads it (RF-140): a category outside the account's scope is no category.
function proposedCategory(delivery: PendingDeliveryRow, lookup: Lookup): string | null {
  return proposedCategoryId(delivery, { categories: lookup.categories, accounts: [...lookup.accounts.values()] });
}

// What the message did not give, by the card's own rule: a category counts only when the merchant or the
// interpreter named it, and an income into a fund account still asks «De quién».
function notDetectedOf(delivery: PendingDeliveryRow, lookup: Lookup): string[] {
  const account = delivery.proposedAccountId === null ? undefined : lookup.accounts.get(delivery.proposedAccountId);
  const named =
    delivery.categorySource === "merchant" ||
    delivery.categorySource === "interpreter" ||
    delivery.categorySource === "recipient";
  const transfer = delivery.proposedDirection === "transfer";
  const absent: Record<string, boolean> = {
    amount: delivery.proposedAmountCents === null,
    kind: delivery.proposedDirection === null,
    account: usableAccount(delivery, lookup) === null,
    toAccount: transfer && delivery.proposedToAccountId === null,
    category: !transfer && (proposedCategory(delivery, lookup) === null || !named),
    date: delivery.proposedOccurredAt === null,
    description: delivery.proposedDescription === null,
    contributor: delivery.proposedDirection === "income" && account?.groupId != null,
  };
  return Object.keys(absent).filter((field) => absent[field]);
}

// The form a person would have submitted from the card: the proposal, with each override laid over it.
// A field neither side gives is refused by name, before anything is written.
function acceptForm(delivery: PendingDeliveryRow, item: AcceptItem, lookup: Lookup) {
  const missing = (field: string): never => {
    throw new BatchRefusal(`mcp.errors.inbox.missing.${field}`, delivery.id, field);
  };
  const amountCents = item.amountCents ?? delivery.proposedAmountCents ?? missing("amount");
  const transfer =
    item.kind === "transfer" ||
    (item.kind === undefined &&
      ((!!item.fromAccountId && !!item.toAccountId) || delivery.proposedDirection === "transfer"));
  if (!transfer && (item.fromAccountId || item.toAccountId)) {
    throw new BatchRefusal("mcp.errors.inbox.sideNeedsTransfer", delivery.id);
  }
  const income = (item.kind ?? delivery.proposedDirection) === "income";
  const proposed = usableAccount(delivery, lookup);

  let fromAccountId: string | null;
  let toAccountId: string | null;
  if (transfer) {
    fromAccountId = item.fromAccountId ?? proposed ?? missing("fromAccount");
    toAccountId =
      item.toAccountId ?? (item.fromAccountId ? proposed : delivery.proposedToAccountId) ?? missing("toAccount");
  } else {
    const own = item.accountId ?? proposed ?? missing("account");
    fromAccountId = income ? null : own;
    toAccountId = income ? own : null;
  }

  const categoryId = item.categoryId ?? proposedCategory(delivery, lookup);
  const lines = item.splits ?? (categoryId ? [{ categoryId, amountCents }] : []);
  if (!transfer && lines.length === 0) missing("category");

  return {
    deliveryId: delivery.id,
    fromAccountId,
    toAccountId,
    amount: centsToDecimal(amountCents),
    occurredAt: item.date ?? delivery.proposedOccurredAt ?? todayInBogota(),
    description: item.description === undefined ? delivery.proposedDescription : item.description,
    contributedByMemberId: item.contributedByMemberId,
    madeByMemberId: item.madeByMemberId,
    splits: transfer
      ? []
      : lines.map((line) => ({
          categoryId: line.categoryId,
          amount: centsToDecimal(line.amountCents),
          description: "description" in line ? line.description : undefined,
        })),
    labelIds: [],
  };
}

// Whatever stops a batch answers as a refusal naming the delivery that stopped it.
function refuse(deliveryId: string, error: unknown): never {
  if (error instanceof BatchRefusal) throw error;
  if (error instanceof DeliveryNotPending) throw new BatchRefusal("errors.notFound", deliveryId);
  if (error instanceof ActionError) throw new BatchRefusal(error.messageKey, deliveryId);
  const code = pgErrorCode(error);
  if (code === "MO001") throw new BatchRefusal("errors.movementBeforeOpening", deliveryId);
  if (code === "23505") throw new BatchRefusal("mcp.errors.inbox.duplicate", deliveryId);
  try {
    mapTransactionError(error);
  } catch (mapped) {
    if (mapped instanceof ActionError) throw new BatchRefusal(mapped.messageKey, deliveryId);
    console.error("mcp inbox failed:", mapped instanceof Error ? mapped.name : "unknown", pgErrorCode(mapped) ?? "");
    throw new BatchRefusal("mcp.errors.unknown", deliveryId);
  }
}

// Every id must name one of the person's own pending deliveries: a stranger's, a resolved one and a
// repeated id are all the same «not found», and nothing is read twice.
async function loadPending(ids: string[]): Promise<Map<string, PendingDeliveryRow>> {
  const uuid = z.uuid({ error: "ingest.errors.deliveryInvalid" });
  ids.forEach((id) => {
    if (!uuid.safeParse(id).success) throw new BatchRefusal("ingest.errors.deliveryInvalid", id);
  });
  const rows = new Map((await listDeliveries({ ids })).map((row) => [row.id, row]));
  const seen = new Set<string>();
  for (const id of ids) {
    if (!rows.has(id) || seen.has(id)) throw new BatchRefusal("errors.notFound", id);
    seen.add(id);
  }
  return rows;
}

export function registerInboxTools(server: McpServer, run: Run, t: Say): void {
  const d = (key: string) => t(`params.${key}`);

  server.registerTool(
    "list_inbox",
    {
      description: t("tools.listInbox"),
      inputSchema: z.object({
        status: z.enum(["pending", "accepted", "rejected"]).optional().describe(d("inboxStatus")),
        limit: z.number().int().min(1).max(200).optional().describe(d("limit")),
        offset: z.number().int().min(0).optional().describe(d("offset")),
      }),
      annotations: { readOnlyHint: true },
    },
    (input: { status?: "pending" | "accepted" | "rejected"; limit?: number; offset?: number }, ctx) =>
      run(ctx, (owner) =>
        withSharedTransaction(async () => {
          const status = input.status ?? "pending";
          const [rows, lookup] = await Promise.all([
            listDeliveries({ status, limit: input.limit ?? 50, offset: input.offset }),
            readLookup(owner),
          ]);
          const paths = categoryPathsById(lookup.categories, categoryNamesById(lookup.categories, (name) => name));
          return rows.map((row) => {
            const account = row.proposedAccountId === null ? undefined : lookup.accounts.get(row.proposedAccountId);
            const categoryId = row.proposedDirection === "transfer" ? null : proposedCategory(row, lookup);
            const toAccount = row.proposedToAccountId === null ? undefined : lookup.accounts.get(row.proposedToAccountId);
            const base = {
              id: row.id,
              receivedAt: row.createdAt,
              rawText: row.rawText,
              // RF-189: the number the message names and whom it is saved as; null recipient means ask the
              // person what it is and save it with save_recipient.
              extractedNumber: row.extractedIdentifier,
              recipientId: row.recipientId,
              recipientName: row.recipientName,
              proposal: {
                amountCents: row.proposedAmountCents,
                currency: account?.settlementCurrency ?? null,
                kind: row.proposedDirection,
                accountId: row.proposedAccountId,
                accountName: account?.name ?? null,
                // A transfer leaves accountId and lands here.
                toAccountId: row.proposedToAccountId,
                toAccountName: toAccount?.name ?? null,
                categoryId,
                categoryPath: categoryId === null ? null : (paths.get(categoryId) ?? null),
                date: row.proposedOccurredAt,
                description: row.proposedDescription,
              },
            };
            if (status !== "pending") return { ...base, resolvedAt: row.resolvedAt, transactionId: row.transactionId };
            // What the message did not give: Claude fills these in the list it shows, never silently.
            return { ...base, notDetected: notDetectedOf(row, lookup), beforeAccountOpening: row.beforeOpening };
          });
        }),
      ),
  );

  server.registerTool(
    "accept_deliveries",
    {
      description: t("tools.acceptDeliveries"),
      inputSchema: z.object({ deliveries: z.array(acceptItem).min(1).max(50).describe(d("deliveries")) }),
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false },
    },
    (input: { deliveries: AcceptItem[] }, ctx) =>
      run(ctx, async (owner) => {
        // Everything is read and validated first, each item by the form's own schema and contributor rule;
        // the writes then share one transaction, so a refusal anywhere leaves every delivery pending.
        const [pending, lookup] = await withSharedTransaction(() =>
          Promise.all([loadPending(input.deliveries.map((item) => item.id)), readLookup(owner)]),
        );
        const forms = await Promise.all(
          input.deliveries.map(async (item) => {
            try {
              const form = acceptForm(pending.get(item.id)!, item, lookup);
              const verdict = acceptDeliverySchema.safeParse(form);
              if (!verdict.success) throw new BatchRefusal(verdict.error.issues[0].message, item.id);
              await assertContributorGiven(verdict.data);
              return verdict.data;
            } catch (error) {
              return refuse(item.id, error);
            }
          }),
        );
        return withUserDb(async (tx) => {
          const accepted: { deliveryId: string; transactionId: string }[] = [];
          for (const form of forms) {
            try {
              const { transactionId } = await acceptDelivery(
                {
                  deliveryId: form.deliveryId,
                  fromAccountId: form.fromAccountId,
                  toAccountId: form.toAccountId,
                  amountCents: toCents(form.amount),
                  occurredAt: form.occurredAt,
                  description: form.description,
                  splits: form.splits.map((split) => ({
                    categoryId: split.categoryId,
                    amountCents: toCents(split.amount),
                    description: split.description,
                  })),
                  labelIds: form.labelIds,
                  contributedByMemberId: form.contributedByMemberId ?? null,
                  madeByMemberId: form.madeByMemberId ?? null,
                },
                tx,
              );
              accepted.push({ deliveryId: form.deliveryId, transactionId });
            } catch (error) {
              refuse(form.deliveryId, error);
            }
          }
          return { accepted };
        });
      }),
  );

  server.registerTool(
    "reject_deliveries",
    {
      description: t("tools.rejectDeliveries"),
      inputSchema: z.object({ ids: z.array(z.string()).min(1).max(50).describe(d("deliveryIds")) }),
      annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false },
    },
    (input: { ids: string[] }, ctx) =>
      run(ctx, async () => {
        await loadPending(input.ids);
        return withUserDb(async (tx) => {
          for (const id of input.ids) {
            try {
              await rejectDelivery({ deliveryId: id, silenceShape: false }, tx);
            } catch (error) {
              refuse(id, error);
            }
          }
          return { rejected: input.ids };
        });
      }),
  );
}
