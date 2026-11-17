import "server-only";

import type { CallToolResult, McpServer, ServerContext } from "@modelcontextprotocol/server";
import { createMcpHandler } from "mcp-handler";
import { createTranslator } from "next-intl";
import { z } from "zod";

import { listAccounts } from "@/db/queries/accounts";
import { listCallerMembers } from "@/db/queries/group-members";
import { getMonthReview } from "@/db/queries/month-review";
import { getSpendingPatterns, GROWTH_PERCENT } from "@/db/queries/spending-patterns";
import { importStatement, previewStatement, StatementError } from "@/db/queries/statement-import";
import { actAsCredentialOwner } from "@/db/session";
import { MONTH_PATTERN, lastClosedMonth } from "@/lib/dates";
import { ABOVE_USUAL_FACTOR, USUAL_WINDOW_MONTHS } from "@/lib/month-review-rules";
import { ActionError, DATABASE_REFUSALS } from "@/lib/errors";
import { env } from "@/lib/env";
import { pgErrorCode } from "@/lib/db-error";
import { DESTROY, READ, titled } from "@/lib/mcp/annotations";
import { movementWarnings, withWarnings, type Probe } from "@/lib/mcp/debt-guard";
import { registerDebtTools } from "@/lib/mcp/debt-tools";
import { registerBudgetTools } from "@/lib/mcp/budget-tools";
import { registerGoalTools } from "@/lib/mcp/goal-tools";
import { registerPlannedPaymentTools } from "@/lib/mcp/planned-payment-tools";
import { registerRecurringTools } from "@/lib/mcp/recurring-tools";
import { accountRow, registerAccountTools } from "@/lib/mcp/account-tools";
import { registerDebtStatementTools } from "@/lib/mcp/statement-tools";
import { registerReportTools } from "@/lib/mcp/report-tools";
import { registerReviewTools } from "@/lib/mcp/review-tools";
import { registerMemberTools } from "@/lib/mcp/member-tools";
import { registerDeleteTools } from "@/lib/mcp/delete-tools";
import { BatchRefusal, registerInboxTools } from "@/lib/mcp/inbox-tools";
import { registerLabelTools } from "@/lib/mcp/label-tools";
import { registerMemberDebtTools } from "@/lib/mcp/member-debt-tools";
import { registerRecipientTools } from "@/lib/mcp/recipient-tools";
import { registerThirdPartyCreditTools } from "@/lib/mcp/third-party-credit-tools";
import { registerLedgerTools } from "@/lib/mcp/write-tools";
import { statementImportSchema, statementSchema, type StatementInput } from "@/lib/validation/statement-import";

import es from "../../messages/es.json";
import pkg from "../../package.json";

// The configured origin: issuer, resource and the 401's metadata link on the host a request does not name.
export const ISSUER = env.NEXT_PUBLIC_SITE_URL.replace(/\/+$/, "");


export const RESOURCE_METADATA_PATH = "/.well-known/oauth-protected-resource/mcp";

// A tool answers outside a request, where next-intl's request config does not run.
const t = createTranslator({ locale: "es", messages: { mcp: es.mcp }, namespace: "mcp" });
const say = (key: string) => t(key as never);

// A write refuses in the key a form would show; the whole catalogue is read, since those keys live in
// every namespace. A key the catalogue lacks answers the generic sentence, never the key itself.
const tForm = createTranslator({ locale: "es", messages: es });
function refusal(key: string, values?: Record<string, string>): string {
  return tForm.has(key as never) ? tForm(key as never, values as never) : t("errors.unknown");
}

// The owner `withMcpAuth` carries, put there by the route's `verify` alone.
function ownerOf(ctx: ServerContext): string | null {
  const owner = ctx.http?.authInfo?.extra?.ownerUserId;
  return typeof owner === "string" && owner !== "" ? owner : null;
}

function text(value: unknown, isError = false): CallToolResult {
  return { content: [{ type: "text", text: JSON.stringify(value) }], ...(isError ? { isError } : {}) };
}

// Every tool runs as the credential's owner, so the policies scope it exactly as they scope that
// person's own screens; a failure answers a sentence, never the driver's message (it carries the query).
async function run(ctx: ServerContext, load: (owner: string) => Promise<unknown>): Promise<CallToolResult> {
  const owner = ownerOf(ctx);
  if (owner === null) return text({ error: t("errors.unauthorized") }, true);
  try {
    return text(await actAsCredentialOwner(owner, () => load(owner)));
  } catch (error) {
    if (error instanceof StatementError) {
      return text({ error: t(`errors.statement.${error.key}`), line: error.line }, true);
    }
    if (error instanceof BatchRefusal) {
      return text({ error: refusal(error.messageKey), deliveryId: error.deliveryId, ...(error.field ? { field: error.field } : {}) }, true);
    }
    if (error instanceof ActionError) return text({ error: refusal(error.messageKey, error.values) }, true);
    const code = pgErrorCode(error);
    if (code !== undefined && Object.hasOwn(DATABASE_REFUSALS, code)) return text({ error: refusal(DATABASE_REFUSALS[code]) }, true);
    console.error("mcp tool failed:", error instanceof Error ? error.name : "unknown", code ?? "");
    return text({ error: t("errors.unknown") }, true);
  }
}

const MONTH = z.string().regex(MONTH_PATTERN);

function registerReadTools(server: McpServer): void {
  server.registerTool(
    "list_accounts",
    {
      ...titled(say, "listAccounts"),
      description: t("tools.listAccounts"),
      inputSchema: z.object({ archived: z.boolean().optional().describe(t("params.accountsArchived")) }),
      annotations: READ,
    },
    (input: { archived?: boolean }, ctx) =>
      run(ctx, async () =>
        (await listAccounts({ archived: input.archived ?? false })).map(accountRow),
      ),
  );

  // RF-181, RF-182: the ids holderMemberId, contributedByMemberId and madeByMemberId take.
  server.registerTool(
    "list_members",
    {
      ...titled(say, "listMembers"),
      description: t("tools.listMembers"),
      inputSchema: z.object({ archived: z.boolean().optional().describe(t("params.membersArchived")) }),
      annotations: READ,
    },
    (input: { archived?: boolean }, ctx) =>
      run(ctx, async (owner) =>
        (await listCallerMembers(owner, { archived: input.archived ?? false })).map((member) => ({
          id: member.id,
          name: member.name,
          role: member.role,
          hasLogin: member.userId !== null,
          archived: member.archivedAt !== null,
        })),
      ),
  );

  // RF-155: the same items «Revisar el mes» lists, by the same fixed rules; Claude reviews them in the
  // conversation, the app calls no model.
  server.registerTool(
    "review_month",
    {
      ...titled(say, "reviewMonth"),
      description: t("tools.reviewMonth"),
      inputSchema: z.object({ month: MONTH.optional().describe(t("tools.monthParam")) }),
      annotations: READ,
    },
    (input: { month?: string }, ctx) => {
      const month = input.month ?? lastClosedMonth();
      // A month still open is not reviewed: its items could still change (RF-155 reviews a closed month).
      if (month > lastClosedMonth()) return Promise.resolve(text({ error: t("errors.openMonth") }, true));
      return run(ctx, () => getMonthReview(month));
    },
  );

  // RF-184: the patterns by fixed rules; Claude finds what to act on in the conversation, the app calls no model.
  server.registerTool(
    "spending_patterns",
    {
      ...titled(say, "spendingPatterns"),
      description: t("tools.spendingPatterns", { factor: ABOVE_USUAL_FACTOR, window: USUAL_WINDOW_MONTHS, growth: GROWTH_PERCENT }),
      inputSchema: z.object({ months: z.number().int().min(1).max(24).optional().describe(t("tools.monthsParam")) }),
      annotations: READ,
    },
    (input: { months?: number }, ctx) => run(ctx, () => getSpendingPatterns(input.months ?? 12)),
  );
}

// The lines of a statement that read as debt, a loan or a saving in an account's expense or income.
function statementProbes(input: StatementInput): Probe[] {
  return input.rows.flatMap((row) =>
    row.counterAccountId
      ? []
      : [{ kind: row.amountCents < 0 ? ("expense" as const) : ("income" as const), description: row.description, categoryIds: row.categoryId ? [row.categoryId] : [], line: row.line }],
  );
}

// RF-144: a statement Claude read enters in two calls. The preview writes nothing and returns the
// key the import must quote back, so no import runs on lines nobody looked at.
function registerStatementTools(server: McpServer): void {
  server.registerTool(
    "preview_statement",
    { ...titled(say, "previewStatement"), description: t("tools.previewStatement"), inputSchema: statementSchema, annotations: READ },
    (input, ctx) =>
      run(ctx, async (owner) => {
        const preview = await previewStatement(input);
        // RF-136: a line with instalments reads as the proposal a person confirms, never as done.
        const lines = preview.lines.map((line) =>
          line.deferral
            ? { ...line, deferral: { ...line.deferral, proposal: t("deferralProposal", { count: line.deferral.instalments }) } }
            : line,
        );
        return withWarnings({ ...preview, lines }, await movementWarnings(owner, statementProbes(input), say));
      }),
  );
  server.registerTool(
    "import_statement",
    {
      ...titled(say, "importStatement"),
      description: t("tools.importStatement"),
      inputSchema: statementImportSchema,
      annotations: DESTROY,
    },
    (input, ctx) =>
      run(ctx, async (owner) => withWarnings(await importStatement(input), await movementWarnings(owner, statementProbes(input), say))),
  );
}

export function buildHandler(): (request: Request) => Promise<Response> {
  return createMcpHandler((server) => {
    registerReadTools(server);
    registerStatementTools(server);
    registerLedgerTools(server, run, say);
    registerInboxTools(server, run, say);
    registerMemberDebtTools(server, run, say);
    registerRecipientTools(server, run, say);
    registerThirdPartyCreditTools(server, run, say);
    registerLabelTools(server, run, say);
    registerDebtTools(server, run, say);
    registerBudgetTools(server, run, say);
    registerGoalTools(server, run, say);
    registerPlannedPaymentTools(server, run, say);
    registerRecurringTools(server, run, say);
    registerAccountTools(server, run, say);
    registerDebtStatementTools(server, run, say);
    registerReportTools(server, run, say);
    registerReviewTools(server, run, say);
    registerMemberTools(server, run, say);
    registerDeleteTools(server, run, say);
  }, {
    serverInfo: { name: "homefund", version: pkg.version },
    instructions: t("instructions"),
  });
}
