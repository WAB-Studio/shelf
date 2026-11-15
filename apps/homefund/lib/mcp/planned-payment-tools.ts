import "server-only";

import type { CallToolResult, McpServer, ServerContext } from "@modelcontextprotocol/server";
import { z } from "zod";

import { openPlannedPayment, revisePlannedPayment, settlePlanned } from "@/db/queries/planned-payment-write";
import { cancelPlannedPayment, listPlannedPayments } from "@/db/queries/planned-payments";
import { ActionError } from "@/lib/errors";
import { ADD, ADD_ONCE, DESTROY, OVERWRITE, READ, previousFields, titled } from "@/lib/mcp/annotations";
import { parseForm } from "@/lib/mcp/parse-form";
import { centsToDecimal } from "@/lib/money";
import {
  cancelPlannedPaymentSchema,
  createPlannedPaymentSchema,
  settlePlannedPaymentSchema,
  updatePlannedPaymentSchema,
} from "@/lib/validation/planned-payment";

type Run = (ctx: ServerContext, load: (owner: string) => Promise<unknown>) => Promise<CallToolResult>;
type Say = (key: string) => string;

const STATUSES = ["pending", "done", "cancelled"] as const;

// RF-230: the Por pagar screen's list and writes, through its own query, schemas and write functions. A payment is the id
// `list_planned_payments` answers; settling it books the real movement, and deleting that movement puts it back to pending.
export function registerPlannedPaymentTools(server: McpServer, run: Run, t: Say): void {
  const d = (key: string) => t(`params.${key}`);

  server.registerTool(
    "list_planned_payments",
    {
      ...titled(t, "listPlannedPayments"),
      description: t("tools.listPlannedPayments"),
      inputSchema: z.object({ status: z.enum(STATUSES).optional().describe(d("plannedStatus")) }),
      annotations: READ,
    },
    (input: { status?: (typeof STATUSES)[number] }, ctx) => run(ctx, () => listPlannedPayments({ status: input.status })),
  );

  server.registerTool(
    "create_planned_payment",
    {
      ...titled(t, "createPlannedPayment"),
      description: t("tools.createPlannedPayment"),
      inputSchema: z.object({
        fromAccountId: z.string().nullable().describe(d("fromAccountId")),
        toAccountId: z.string().nullable().describe(d("toAccountId")),
        amountCents: z.number().int().describe(d("amountCents")),
        categoryId: z.string().nullish().describe(d("plannedCategoryId")),
        dueDate: z.string().describe(d("plannedDueDate")),
        remindOn: z.string().nullish().describe(d("plannedRemindOn")),
        description: z.string().nullish().describe(d("description")),
      }),
      annotations: ADD,
    },
    (input, ctx) =>
      run(ctx, () =>
        openPlannedPayment(
          parseForm(createPlannedPaymentSchema, {
            fromAccountId: input.fromAccountId,
            toAccountId: input.toAccountId,
            amount: centsToDecimal(input.amountCents),
            categoryId: input.categoryId,
            dueDate: input.dueDate,
            remindOn: input.remindOn,
            description: input.description,
          }),
        ),
      ),
  );

  // The stamp is the one list_planned_payments answered: an edit over someone else's save is refused as out of date (RF-156).
  server.registerTool(
    "update_planned_payment",
    {
      ...titled(t, "updatePlannedPayment"),
      description: t("tools.updatePlannedPayment"),
      inputSchema: z.object({
        plannedPaymentId: z.string().describe(d("plannedPaymentId")),
        expectedUpdatedAt: z.string().describe(d("expectedUpdatedAt")),
        fromAccountId: z.string().nullish().describe(d("fromAccountId")),
        toAccountId: z.string().nullish().describe(d("toAccountId")),
        amountCents: z.number().int().optional().describe(d("amountCents")),
        categoryId: z.string().nullish().describe(d("plannedCategoryId")),
        dueDate: z.string().optional().describe(d("plannedDueDate")),
        remindOn: z.string().nullish().describe(d("plannedRemindOn")),
        description: z.string().nullish().describe(d("description")),
      }),
      annotations: OVERWRITE,
    },
    (input, ctx) =>
      run(ctx, async () => {
        const plannedPaymentId = parseForm(z.uuid({ error: "errors.notFound" }), input.plannedPaymentId);
        const current = (await listPlannedPayments({ status: "pending" })).find((row) => row.id === plannedPaymentId);
        if (!current || current.foreignOwner) throw new ActionError("errors.notFound");
        const pick = <T>(sent: T | undefined, stored: T): T => (sent === undefined ? stored : sent);
        await revisePlannedPayment(
          parseForm(updatePlannedPaymentSchema, {
            plannedPaymentId,
            fromAccountId: pick(input.fromAccountId, current.fromAccountId),
            toAccountId: pick(input.toAccountId, current.toAccountId),
            amount: centsToDecimal(pick(input.amountCents, current.amountCents)),
            categoryId: pick(input.categoryId, current.categoryId),
            dueDate: pick(input.dueDate, current.dueDate),
            remindOn: pick(input.remindOn, current.remindOn),
            description: pick(input.description, current.description),
            expectedUpdatedAt: input.expectedUpdatedAt,
          }),
        );
        return {
          plannedPaymentId,
          before: previousFields(
            {
              fromAccountId: current.fromAccountId,
              toAccountId: current.toAccountId,
              amountCents: current.amountCents,
              categoryId: current.categoryId,
              dueDate: current.dueDate,
              remindOn: current.remindOn,
              description: current.description,
            },
            input,
          ),
        };
      }),
  );

  server.registerTool(
    "settle_planned_payment",
    {
      ...titled(t, "settlePlannedPayment"),
      description: t("tools.settlePlannedPayment"),
      inputSchema: z.object({
        plannedPaymentId: z.string().describe(d("plannedPaymentId")),
        occurredOn: z.string().describe(d("occurredOn")),
      }),
      annotations: ADD_ONCE,
    },
    (input, ctx) =>
      run(ctx, () =>
        settlePlanned(parseForm(settlePlannedPaymentSchema, { plannedPaymentId: input.plannedPaymentId, occurredAt: input.occurredOn })),
      ),
  );

  server.registerTool(
    "cancel_planned_payment",
    {
      ...titled(t, "cancelPlannedPayment"),
      description: t("tools.cancelPlannedPayment"),
      inputSchema: z.object({ plannedPaymentId: z.string().describe(d("plannedPaymentId")) }),
      annotations: DESTROY,
    },
    (input: { plannedPaymentId: string }, ctx) =>
      run(ctx, async () => {
        const { plannedPaymentId } = parseForm(cancelPlannedPaymentSchema, input);
        const before = (await listPlannedPayments({ status: "pending" })).find((row) => row.id === plannedPaymentId);
        if (!before || !(await cancelPlannedPayment({ plannedPaymentId }))) throw new ActionError("errors.notFound");
        return { plannedPaymentId, before };
      }),
  );
}
