import "server-only";

import type { CallToolResult, McpServer, ServerContext } from "@modelcontextprotocol/server";
import { z } from "zod";

import { listAccounts } from "@/db/queries/accounts";
import { listScopedCategories } from "@/db/queries/categories";
import {
  acceptDelivery,
  DeliveryNotPending,
  listDeliveries,
  rejectDelivery,
  type PendingDeliveryRow,
} from "@/db/queries/ingest-review";
import { mapTransactionError } from "@/db/queries/ledger-write";
import { withSharedTransaction } from "@/db/session";
import { todayInBogota } from "@/lib/dates";
import { ActionError } from "@/lib/errors";
import { categoryNamesById, categoryPathsById } from "@/lib/fund/category-names";
import { centsToDecimal, parseAmount } from "@/lib/money";
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
});

type AcceptItem = z.infer<typeof acceptItem>;

function toCents(amount: string): number {
  const cents = parseAmount(amount);
  if (cents === null) throw new ActionError("errors.unexpected");
  return cents;
}

// The form a person would have submitted from the card: the proposal, with each override laid over it.
// A field neither side gives is refused by name, before anything is written.
function acceptForm(delivery: PendingDeliveryRow, item: AcceptItem) {
  const missing = (field: string): never => {
    throw new BatchRefusal(`mcp.errors.inbox.missing.${field}`, delivery.id, field);
  };
  const amountCents = item.amountCents ?? delivery.proposedAmountCents ?? missing("amount");
  const transfer = item.kind === "transfer" || (item.kind === undefined && item.fromAccountId && item.toAccountId);
  const income = (item.kind ?? delivery.proposedDirection) === "income";
  const accountId = item.accountId ?? delivery.proposedAccountId;

  let fromAccountId: string | null;
  let toAccountId: string | null;
  if (transfer) {
    fromAccountId = item.fromAccountId ?? missing("fromAccount");
    toAccountId = item.toAccountId ?? missing("toAccount");
  } else {
    const own = accountId ?? missing("account");
    fromAccountId = income ? null : own;
    toAccountId = income ? own : null;
  }

  const categoryId = item.categoryId ?? delivery.proposedCategoryId;
  const lines = item.splits ?? (categoryId ? [{ categoryId, amountCents }] : []);
  if (!transfer && lines.length === 0) missing("category");

  return {
    deliveryId: delivery.id,
    fromAccountId,
    toAccountId,
    amount: centsToDecimal(amountCents),
    occurredAt: item.date ?? delivery.proposedOccurredAt ?? todayInBogota(),
    description: item.description === undefined ? delivery.proposedDescription : item.description,
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

function refuse(deliveryId: string, error: unknown): never {
  if (error instanceof BatchRefusal) throw error;
  if (error instanceof DeliveryNotPending) throw new BatchRefusal("errors.notFound", deliveryId);
  if (error instanceof ActionError) throw new BatchRefusal(error.messageKey, deliveryId);
  try {
    mapTransactionError(error);
  } catch (mapped) {
    if (mapped instanceof ActionError) throw new BatchRefusal(mapped.messageKey, deliveryId);
    throw mapped;
  }
  throw error;
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
      run(ctx, async (owner) => {
        const [rows, accounts, categories] = await Promise.all([
          listDeliveries({ status: input.status, limit: input.limit ?? 50, offset: input.offset }),
          listAccounts({ archived: false }),
          listScopedCategories(owner),
        ]);
        const accountById = new Map(accounts.map((account) => [account.id, account]));
        const paths = categoryPathsById(categories, categoryNamesById(categories, (name) => name));
        return rows.map((row) => {
          const account = row.proposedAccountId === null ? undefined : accountById.get(row.proposedAccountId);
          const proposal = {
            amountCents: row.proposedAmountCents,
            currency: account?.settlementCurrency ?? null,
            kind: row.proposedDirection,
            accountId: row.proposedAccountId,
            accountName: account?.name ?? null,
            categoryId: row.proposedCategoryId,
            categoryPath: row.proposedCategoryId === null ? null : (paths.get(row.proposedCategoryId) ?? null),
            date: row.proposedOccurredAt,
            description: row.proposedDescription,
          };
          const absent = {
            amount: proposal.amountCents,
            kind: proposal.kind,
            account: proposal.accountId,
            category: proposal.categoryId,
            date: proposal.date,
            description: proposal.description,
          };
          return {
            id: row.id,
            receivedAt: row.createdAt,
            rawText: row.rawText,
            proposal,
            // What the message did not give: Claude fills these in the list it shows, never silently.
            notDetected: Object.entries(absent).filter(([, value]) => value === null).map(([field]) => field),
            beforeAccountOpening: row.beforeOpening,
          };
        });
      }),
  );

  server.registerTool(
    "accept_deliveries",
    {
      description: t("tools.acceptDeliveries"),
      inputSchema: z.object({ deliveries: z.array(acceptItem).min(1).max(50).describe(d("deliveries")) }),
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false },
    },
    (input: { deliveries: AcceptItem[] }, ctx) =>
      run(ctx, async () => {
        const pending = await loadPending(input.deliveries.map((item) => item.id));
        // Everything is read and validated first; the writes then share one transaction, so a refusal
        // anywhere leaves every delivery pending and no movement written.
        const forms = input.deliveries.map((item) => {
          const form = acceptForm(pending.get(item.id)!, item);
          const verdict = acceptDeliverySchema.safeParse(form);
          if (!verdict.success) throw new BatchRefusal(verdict.error.issues[0].message, item.id);
          return verdict.data;
        });
        return withSharedTransaction(async () => {
          const accepted: { deliveryId: string; transactionId: string }[] = [];
          for (const form of forms) {
            try {
              const { transactionId } = await acceptDelivery({
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
              });
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
        return withSharedTransaction(async () => {
          for (const id of input.ids) {
            try {
              await rejectDelivery({ deliveryId: id, silenceShape: false });
            } catch (error) {
              refuse(id, error);
            }
          }
          return { rejected: input.ids };
        });
      }),
  );
}
