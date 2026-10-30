import "server-only";

import type { CallToolResult, McpServer, ServerContext } from "@modelcontextprotocol/server";
import { createMcpHandler } from "mcp-handler";
import { createTranslator } from "next-intl";
import { z } from "zod";

import { listAccounts } from "@/db/queries/accounts";
import { getMonthReview } from "@/db/queries/month-review";
import { actAsCredentialOwner } from "@/db/session";
import { lastClosedMonth } from "@/lib/dates";
import { env } from "@/lib/env";
import { pgErrorCode } from "@/lib/db-error";

import es from "../../messages/es.json";
import pkg from "../../package.json";

export const MCP_URL = `${env.NEXT_PUBLIC_SITE_URL.replace(/\/+$/, "")}/mcp`;

export const RESOURCE_METADATA_PATH = "/.well-known/oauth-protected-resource/mcp";

// A tool answers outside a request, where next-intl's request config does not run.
const t = createTranslator({ locale: "es", messages: { mcp: es.mcp }, namespace: "mcp" });

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
async function run(ctx: ServerContext, load: () => Promise<unknown>): Promise<CallToolResult> {
  const owner = ownerOf(ctx);
  if (owner === null) return text({ error: t("errors.unauthorized") }, true);
  try {
    return text(await actAsCredentialOwner(owner, load));
  } catch (error) {
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
          settlementCurrency: account.settlementCurrency,
          balances: account.balances,
          canWrite: account.canWrite,
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

export function buildHandler(): (request: Request) => Promise<Response> {
  return createMcpHandler(registerReadTools, {
    serverInfo: { name: "homefund", version: pkg.version },
    instructions: t("instructions"),
  });
}
