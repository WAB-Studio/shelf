import type { CallToolResult, McpServer, ServerContext } from "@modelcontextprotocol/server";

import { pgCode } from "@/lib/db-error";
import { errorOf } from "@/lib/mcp/errors";
import type { ResolvedPerson } from "@/lib/mcp/tokens";
import { actAs } from "@/lib/session";
import { writeTools, type ToolOutcome } from "@/lib/tools/catalogue";

function answer(outcome: ToolOutcome, tool?: string): CallToolResult {
  if (!outcome.ok) {
    return { content: [{ type: "text", text: JSON.stringify(errorOf(outcome.error, outcome.values, tool)) }], isError: true };
  }
  return { content: [{ type: "text", text: JSON.stringify(outcome.value) }], structuredContent: outcome.value };
}

// `resolveBearer` is the only thing that builds the person `withMcpAuth`
// carries in `extra`, so a shape that is not one means the door was skipped.
function personOf(ctx: ServerContext): ResolvedPerson | null {
  const person = ctx.http?.authInfo?.extra?.person as Partial<ResolvedPerson> | undefined;
  return typeof person?.id === "string" && typeof person.email === "string" ? (person as ResolvedPerson) : null;
}

async function run(ctx: ServerContext, tool: string, act: () => Promise<ToolOutcome>): Promise<CallToolResult> {
  const person = personOf(ctx);
  if (person === null) return answer({ ok: false, error: "mcp.errors.unauthorized" });
  try {
    return answer(await actAs(person, act), tool);
  } catch (error) {
    // The name and the SQLSTATE only: a driver's message carries the query and its parameters (RNP-15).
    console.error("mcp write tool failed:", error instanceof Error ? error.name : "unknown", pgCode(error) ?? "");
    return answer({ ok: false, error: "mcp.errors.unknown" }, tool);
  }
}

export function registerWriteTools(server: McpServer): void {
  // Every act runs unchanged through the catalogue: its schema, its policy checks, its statements.
  for (const spec of writeTools) {
    server.registerTool(
      spec.name,
      { description: spec.description, inputSchema: spec.input, annotations: spec.annotations },
      (input: Record<string, unknown>, ctx) => run(ctx, spec.name, () => spec.run(input)),
    );
  }
}
