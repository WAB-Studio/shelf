import "server-only";

import type { CallToolResult, McpServer, ServerContext } from "@modelcontextprotocol/server";
import { z } from "zod";

import { listAuditLog } from "@/db/queries/audit-log";
import { getDashboardData } from "@/db/queries/reports/dashboard";
import { getReportsData } from "@/db/queries/reports/reports-screen";
import { getTransactionTotals } from "@/db/queries/transactions";
import { MONTH_PATTERN } from "@/lib/dates";
import { READ, READ_WEB, titled } from "@/lib/mcp/annotations";
import { movementFilterShape, movementFilters, type MovementFilterInput } from "@/lib/mcp/write-tools";
import { fetchRate } from "@/lib/rates/source";

type Run = (ctx: ServerContext, load: (owner: string) => Promise<unknown>) => Promise<CallToolResult>;
type Say = (key: string) => string;

// RF-235: what Inicio, Informes and the audit log show, the listing's totals and a proposed exchange rate, each by the
// screen's one query. They only read.
export function registerReportTools(server: McpServer, run: Run, t: Say): void {
  const d = (key: string) => t(`params.${key}`);

  server.registerTool(
    "get_dashboard",
    { ...titled(t, "getDashboard"), description: t("tools.getDashboard"), inputSchema: z.object({}), annotations: READ },
    (_input, ctx) => run(ctx, () => getDashboardData()),
  );

  server.registerTool(
    "get_report",
    {
      ...titled(t, "getReport"),
      description: t("tools.getReport"),
      inputSchema: z.object({ month: z.string().regex(MONTH_PATTERN).optional().describe(t("tools.monthParam")) }),
      annotations: READ,
    },
    (input: { month?: string }, ctx) => run(ctx, () => getReportsData(input.month === undefined ? undefined : `${input.month}-01`)),
  );

  server.registerTool(
    "movement_totals",
    {
      ...titled(t, "movementTotals"),
      description: t("tools.movementTotals"),
      inputSchema: z.object(movementFilterShape(t)),
      annotations: READ,
    },
    (input: MovementFilterInput, ctx) => run(ctx, async (owner) => getTransactionTotals(await movementFilters(owner, input))),
  );

  server.registerTool(
    "list_audit_log",
    {
      ...titled(t, "listAuditLog"),
      description: t("tools.listAuditLog"),
      inputSchema: z.object({
        entity: z.string().optional().describe(d("auditEntity")),
        from: z.iso.date().optional().describe(d("from")),
        to: z.iso.date().optional().describe(d("to")),
        limit: z.number().int().min(1).max(200).optional().describe(d("limit")),
        offset: z.number().int().min(0).optional().describe(d("offset")),
      }),
      annotations: READ,
    },
    (input: { entity?: string; from?: string; to?: string; limit?: number; offset?: number }, ctx) =>
      run(ctx, () => listAuditLog({ entity: input.entity, from: input.from, to: input.to, limit: input.limit ?? 50, offset: input.offset ?? 0 })),
  );

  server.registerTool(
    "propose_rate",
    {
      ...titled(t, "proposeRate"),
      description: t("tools.proposeRate"),
      inputSchema: z.object({ from: z.string().length(3).describe(d("rateFrom")), to: z.string().length(3).describe(d("rateTo")) }),
      annotations: READ_WEB,
    },
    (input: { from: string; to: string }, ctx) => run(ctx, () => fetchRate(input.from.toUpperCase(), input.to.toUpperCase())),
  );
}
