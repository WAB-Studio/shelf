import "server-only";

import type { CallToolResult, McpServer, ServerContext } from "@modelcontextprotocol/server";
import { createMcpHandler } from "mcp-handler";
import { createTranslator } from "next-intl";
import { z } from "zod";

import { listAccounts } from "@/db/queries/accounts";
import { listCallerMembers } from "@/db/queries/group-members";
import { getMonthReview } from "@/db/queries/month-review";
import { importStatement, previewStatement, StatementError } from "@/db/queries/statement-import";
import { actAsCredentialOwner } from "@/db/session";
import { lastClosedMonth } from "@/lib/dates";
import { ActionError } from "@/lib/errors";
import { env } from "@/lib/env";
import { pgErrorCode } from "@/lib/db-error";
import { BatchRefusal, registerInboxTools } from "@/lib/mcp/inbox-tools";
import { registerLedgerTools } from "@/lib/mcp/write-tools";
import { statementImportSchema, statementSchema } from "@/lib/validation/statement-import";

import es from "../../messages/es.json";
import pkg from "../../package.json";

// The configured origin: issuer, resource and the 401's metadata link on the host a request does not name.
export const ISSUER = env.NEXT_PUBLIC_SITE_URL.replace(/\/+$/, "");

export const MCP_URL = `${ISSUER}/mcp`;

export const RESOURCE_METADATA_PATH = "/.well-known/oauth-protected-resource/mcp";

// A tool answers outside a request, where next-intl's request config does not run.
const t = createTranslator({ locale: "es", messages: { mcp: es.mcp }, namespace: "mcp" });

// A write refuses in the key a form would show; the whole catalogue is read, since those keys live in
// every namespace. A key the catalogue lacks answers the generic sentence, never the key itself.
const tForm = createTranslator({ locale: "es", messages: es });
function refusal(key: string): string {
  return tForm.has(key as never) ? tForm(key as never) : t("errors.unknown");
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
    if (error instanceof ActionError) return text({ error: refusal(error.messageKey) }, true);
    console.error("mcp tool failed:", error instanceof Error ? error.name : "unknown", pgErrorCode(error) ?? "");
    return text({ error: t("errors.unknown") }, true);
  }
}

const MONTH = z.string().regex(/^\d{4}-(0[1-9]|1[0-2])$/);

function registerReadTools(server: McpServer): void {
  server.registerTool(
    "list_accounts",
    { description: t("tools.listAccounts"), inputSchema: z.object({}), annotations: { readOnlyHint: true } },
    (_input, ctx) =>
      run(ctx, async () =>
        (await listAccounts({ archived: false })).map((account) => ({
          id: account.id,
          name: account.name,
          kind: account.kind,
          subtype: account.subtype,
          scope: account.groupId === null ? "personal" : "fund",
          institution: account.institution,
          lastFour: account.lastFour ?? null,
          // The account this one is a pocket of, null for an account of its own (RF-173); a parent's balances are its free part.
          parentAccountId: account.parentAccountId ?? null,
          // The fund member this account is in the name of (RF-181), null for an account of everyone.
          holderMemberId: account.holderMemberId ?? null,
          holderName: account.holderName ?? null,
          settlementCurrency: account.settlementCurrency,
          // What update_account takes back: the opening as the form shows it (a liability's debt positive), its date and the stamp.
          openingBalanceCents: account.kind === "liability" ? -account.initialBalanceCents : account.initialBalanceCents,
          balanceOn: account.initialBalanceOn,
          updatedAt: account.updatedAt,
          balances: account.balances,
          canWrite: account.canWrite,
        })),
      ),
  );

  // RF-181, RF-182: the ids holderMemberId, contributedByMemberId and madeByMemberId take.
  server.registerTool(
    "list_members",
    { description: t("tools.listMembers"), inputSchema: z.object({}), annotations: { readOnlyHint: true } },
    (_input, ctx) =>
      run(ctx, async (owner) =>
        (await listCallerMembers(owner, { archived: false })).map((member) => ({
          id: member.id,
          name: member.name,
          hasLogin: member.userId !== null,
        })),
      ),
  );

  // RF-155: the same items «Revisar el mes» lists, by the same fixed rules; Claude reviews them in the
  // conversation, the app calls no model.
  server.registerTool(
    "review_month",
    {
      description: t("tools.reviewMonth"),
      inputSchema: z.object({ month: MONTH.optional().describe(t("tools.monthParam")) }),
      annotations: { readOnlyHint: true },
    },
    (input: { month?: string }, ctx) => {
      const month = input.month ?? lastClosedMonth();
      // A month still open is not reviewed: its items could still change (RF-155 reviews a closed month).
      if (month > lastClosedMonth()) return Promise.resolve(text({ error: t("errors.openMonth") }, true));
      return run(ctx, () => getMonthReview(month));
    },
  );
}

// RF-144: a statement Claude read enters in two calls. The preview writes nothing and returns the
// key the import must quote back, so no import runs on lines nobody looked at.
function registerStatementTools(server: McpServer): void {
  server.registerTool(
    "preview_statement",
    { description: t("tools.previewStatement"), inputSchema: statementSchema, annotations: { readOnlyHint: true } },
    (input, ctx) =>
      run(ctx, async () => {
        const preview = await previewStatement(input);
        // RF-136: a line with instalments reads as the proposal a person confirms, never as done.
        const lines = preview.lines.map((line) =>
          line.deferral
            ? { ...line, deferral: { ...line.deferral, proposal: t("deferralProposal", { count: line.deferral.instalments }) } }
            : line,
        );
        return { ...preview, lines };
      }),
  );
  server.registerTool(
    "import_statement",
    {
      description: t("tools.importStatement"),
      inputSchema: statementImportSchema,
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true },
    },
    (input, ctx) => run(ctx, () => importStatement(input)),
  );
}

export function buildHandler(): (request: Request) => Promise<Response> {
  return createMcpHandler((server) => {
    registerReadTools(server);
    registerStatementTools(server);
    registerLedgerTools(server, run, (key) => t(key as never));
    registerInboxTools(server, run, (key) => t(key as never));
  }, {
    serverInfo: { name: "homefund", version: pkg.version },
    instructions: t("instructions"),
  });
}
