import "server-only";

import type { CallToolResult, McpServer, ServerContext } from "@modelcontextprotocol/server";
import { z } from "zod";

import { getMovementDeferral } from "@/db/queries/deferrals";
import { markReviewed, unmarkReviewed } from "@/db/queries/month-review";
import { getTransactionById } from "@/db/queries/transactions";
import { pgErrorCode } from "@/lib/db-error";
import { ActionError } from "@/lib/errors";
import { OVERWRITE, READ, titled } from "@/lib/mcp/annotations";
import { parseForm } from "@/lib/mcp/parse-form";
import { movementRow } from "@/lib/mcp/write-tools";
import { REVIEW_RULES } from "@/lib/month-review-rules";
import { markReviewedSchema } from "@/lib/validation/month-review";

type Run = (ctx: ServerContext, load: (owner: string) => Promise<unknown>) => Promise<CallToolResult>;
type Say = (key: string) => string;

// RF-236: «Está bien» and «Deshacer» on the items of «Revisar el mes», and one movement read whole, through the screens'
// own queries and schemas.
export function registerReviewTools(server: McpServer, run: Run, t: Say): void {
  const d = (key: string) => t(`params.${key}`);
  const marking = z.object({
    transactionIds: z.array(z.string()).min(1).max(50).describe(d("reviewTransactionIds")),
    rule: z.enum(REVIEW_RULES).describe(d("reviewRule")),
  });

  server.registerTool(
    "mark_month_review",
    { ...titled(t, "markMonthReview"), description: t("tools.markMonthReview"), inputSchema: marking, annotations: OVERWRITE },
    (input, ctx) =>
      run(ctx, async () => {
        const form = parseForm(markReviewedSchema, input);
        try {
          await markReviewed(form);
        } catch (error) {
          // A movement the caller only reads is refused by the insert policy, as the button says it.
          if (pgErrorCode(error) === "42501") throw new ActionError("review.errors.cannotMark");
          throw error;
        }
        return { count: form.transactionIds.length, transactionIds: form.transactionIds, rule: form.rule };
      }),
  );

  server.registerTool(
    "unmark_month_review",
    { ...titled(t, "unmarkMonthReview"), description: t("tools.unmarkMonthReview"), inputSchema: marking, annotations: OVERWRITE },
    (input, ctx) =>
      run(ctx, async () => {
        const form = parseForm(markReviewedSchema, input);
        if (!(await unmarkReviewed(form))) throw new ActionError("review.errors.cannotUndo");
        return { count: form.transactionIds.length, transactionIds: form.transactionIds, rule: form.rule };
      }),
  );

  server.registerTool(
    "get_movement",
    {
      ...titled(t, "getMovement"),
      description: t("tools.getMovement"),
      inputSchema: z.object({ transactionId: z.string().describe(d("transactionId")) }),
      annotations: READ,
    },
    (input: { transactionId: string }, ctx) =>
      run(ctx, async () => {
        const id = parseForm(z.uuid({ error: "errors.notFound" }), input.transactionId);
        const [row, { deferral }] = await Promise.all([getTransactionById(id), getMovementDeferral(id)]);
        if (row === null) throw new ActionError("errors.notFound");
        return {
          ...movementRow(row),
          createdByUserId: row.createdBy,
          recurringRuleId: row.recurringRuleId,
          reviewedAt: row.reviewedAt,
          causedByTransactionId: row.causedByTransactionId,
          reconciliationId: row.reconciliationId,
          settledPlannedPayment: row.settledPlannedPayment,
          deferral,
        };
      }),
  );
}
