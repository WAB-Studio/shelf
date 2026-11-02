import type { CallToolResult } from "@modelcontextprotocol/server";
import { createMcpHandler } from "mcp-handler";

import type { ResolvedPerson } from "@/lib/keys";
import { tools, type ToolOutcome } from "@/lib/mcp/tools";
import { appsBetween, appsByDay, claudeBetween, dayTotals, uploadedDays } from "@/lib/queries";
import { actAs } from "@/lib/session";
import { civilDay } from "@/lib/zone";

import mcp from "../../messages/es/mcp.json";
import pkg from "../../package.json";

const reads = { appsBetween, dayTotals, claudeBetween, appsByDay, uploadedDays };

function answer(outcome: ToolOutcome): CallToolResult {
  if (!outcome.ok) return { content: [{ type: "text", text: JSON.stringify({ error: outcome.error, message: mcp.errors[outcome.error] }) }], isError: true };
  return { content: [{ type: "text", text: JSON.stringify(outcome.value) }], structuredContent: outcome.value };
}

// `verify` in the route is the only thing that puts a person in `extra`; anything else means the door was skipped.
function personOf(ctx: unknown): ResolvedPerson | null {
  const person = (ctx as { http?: { authInfo?: { extra?: { person?: Partial<ResolvedPerson> } } } }).http?.authInfo?.extra?.person;
  return typeof person?.id === "string" && typeof person.email === "string" ? (person as ResolvedPerson) : null;
}

export function buildHandler(): (request: Request) => Promise<Response> {
  return createMcpHandler(
    (server) => {
      for (const spec of tools) {
        server.registerTool(
          spec.name,
          { description: spec.description, inputSchema: spec.input, annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true } },
          async (input: Record<string, unknown>, ctx) => {
            const person = personOf(ctx);
            if (person === null) return answer({ ok: false, error: "unauthorized" });
            try {
              return answer(await actAs(person, () => spec.run(reads, input, civilDay())));
            } catch (error) {
              // The name only: a driver's message carries the query and its parameters.
              console.error("mcp tool failed:", error instanceof Error ? error.name : "unknown");
              return answer({ ok: false, error: "unknown" });
            }
          },
        );
      }
    },
    { serverInfo: { name: "timelog", version: pkg.version }, instructions: mcp.instructions },
  );
}
