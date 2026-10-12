import type { CallToolResult, McpServer, ServerContext } from "@modelcontextprotocol/server";
import { z } from "zod";

import { setMonthBudget } from "@/app/actions/budgets";
import { declareFact } from "@/app/actions/facts";
import {
  completeOneOff,
  createOneOff,
  fixTask,
  scheduleOneOff,
  setOneOffNote,
} from "@/app/actions/one-offs";
import {
  addCommitment,
  addPhase,
  createGoal,
  moveHorizon,
  renameGoal,
  retireCommitment,
} from "@/app/actions/plan";
import { pgCode } from "@/lib/db-error";
import { errorOf } from "@/lib/mcp/errors";
import type { ResolvedPerson } from "@/lib/mcp/tokens";
import { actAs } from "@/lib/session";

import mcp from "../../../messages/es/mcp.json";

type ActResult = { ok: true } | { ok: true; [key: string]: unknown } | { ok: false; error: string; values?: { name?: string; date?: string } };

function answer(result: ActResult): CallToolResult {
  if (!result.ok) {
    return { content: [{ type: "text", text: JSON.stringify(errorOf(result.error, result.values)) }], isError: true };
  }
  const value = result as Record<string, unknown>;
  return { content: [{ type: "text", text: JSON.stringify(value) }], structuredContent: value };
}

// `resolveBearer` is the only thing that builds the person `withMcpAuth`
// carries in `extra`, so a shape that is not one means the door was skipped.
function personOf(ctx: ServerContext): ResolvedPerson | null {
  const person = ctx.http?.authInfo?.extra?.person as Partial<ResolvedPerson> | undefined;
  return typeof person?.id === "string" && typeof person.email === "string" ? (person as ResolvedPerson) : null;
}

// The tools speak snake_case; the acts' schemas speak camelCase. A key maps
// one to one, so nothing is renamed by guesswork and the act's own schema
// still judges every value.
function camelKeys(input: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(
    Object.entries(input).map(([key, value]) => [key.replace(/_([a-z])/g, (_, c: string) => c.toUpperCase()), value]),
  );
}

async function run(ctx: ServerContext, act: () => Promise<ActResult>): Promise<CallToolResult> {
  const person = personOf(ctx);
  if (person === null) return answer({ ok: false, error: "mcp.errors.unauthorized" });
  try {
    return answer(await actAs(person, act));
  } catch (error) {
    // The name and the SQLSTATE only: a driver's message carries the query and its parameters (RNP-15).
    console.error("mcp write tool failed:", error instanceof Error ? error.name : "unknown", pgCode(error) ?? "");
    return answer({ ok: false, error: "mcp.errors.unknown" });
  }
}

// The inputs are as loose as the wire allows: the act's own schema is what
// refuses a value, with its own key, and a stricter shape here would turn
// that refusal into a protocol error nobody can read.
const id = z.string();
const text = z.string();
const month = z.string();
const day = z.string();
const count = z.number();

export function registerWriteTools(server: McpServer): void {
  const writes = { readOnlyHint: false, destructiveHint: false, idempotentHint: false } as const;

  // Every act below runs unchanged: its schema, its policy checks, its statements.
  function tool<S extends z.ZodRawShape>(
    name: keyof typeof mcp.tools,
    shape: S,
    act: (input: Record<string, unknown>) => Promise<ActResult>,
  ): void {
    server.registerTool(
      name,
      { description: mcp.tools[name], inputSchema: z.object(shape), annotations: writes },
      (input: Record<string, unknown>, ctx) => run(ctx, () => act(camelKeys(input))),
    );
  }

  tool(
    "declare_fact",
    {
      commitment_id: id.optional(),
      one_off_id: id.optional(),
      quantity: count.optional(),
      note: text.optional(),
      day: day.optional(),
    },
    (input) => declareFact(input as Parameters<typeof declareFact>[0]),
  );

  tool("complete_task", { one_off_id: id }, (input) =>
    completeOneOff(input as Parameters<typeof completeOneOff>[0]),
  );

  tool(
    "create_task",
    {
      name: text,
      day: day.nullable().optional(),
      goal_id: id.optional(),
      estimate: count.optional(),
      planned_month: month.optional(),
      parent_id: id.optional(),
      note: text.optional(),
      in_plan: z.boolean().optional(),
    },
    // The schema takes a missing day as a refusal; a task with none is dayless.
    (input) => createOneOff({ day: null, ...input } as Parameters<typeof createOneOff>[0]),
  );

  // A blank note would empty the task's: the person empties, the AI never does.
  tool("set_task_note", { one_off_id: id, note: text }, (input) =>
    typeof input.note !== "string" || input.note.trim() === ""
      ? Promise.resolve({ ok: false, error: "mcp.errors.noteEmpty" })
      : setOneOffNote(input as Parameters<typeof setOneOffNote>[0]),
  );

  tool("schedule_task", { one_off_id: id, day }, (input) =>
    scheduleOneOff(input as Parameters<typeof scheduleOneOff>[0]),
  );

  tool("set_month_amount", { goal_id: id, month, amount: count }, (input) =>
    setMonthBudget(input as Parameters<typeof setMonthBudget>[0]),
  );

  tool("rename_goal", { goal_id: id, name: text }, (input) =>
    renameGoal(input as Parameters<typeof renameGoal>[0]),
  );

  tool("add_phase", { goal_id: id, aim: text, starts_on: day, ends_on: day }, (input) =>
    addPhase(input as Parameters<typeof addPhase>[0]),
  );

  tool(
    "add_commitment",
    {
      goal_id: id,
      name: text,
      cadence_kind: z.enum(["daily", "weekdays", "times_per_week", "every_n_days", "times_per_month"]),
      cadence_weekdays: z.array(count).optional(),
      cadence_n: count.optional(),
      satisfaction: z.enum(["tap", "quantity", "evidence"]),
      target_quantity: count.optional(),
      unit: text.optional(),
      source_key: text.optional(),
      threshold: count.optional(),
    },
    (input) => addCommitment(input as Parameters<typeof addCommitment>[0]),
  );

  tool("move_horizon", { goal_id: id, horizon: day }, (input) =>
    moveHorizon(input as Parameters<typeof moveHorizon>[0]),
  );

  // Fixing never changes the goal's rhythm (RP-56): the act takes a task and a month alone.
  tool("fix_task", { one_off_id: id, month }, (input) =>
    fixTask({ oneOffId: input.oneOffId, month: input.month } as Parameters<typeof fixTask>[0]),
  );

  tool("unfix_task", { one_off_id: id }, (input) =>
    fixTask({ oneOffId: input.oneOffId, month: null } as Parameters<typeof fixTask>[0]),
  );

  tool("create_goal", { name: text, horizon: day }, (input) =>
    createGoal(input as Parameters<typeof createGoal>[0]),
  );

  tool("retire_commitment", { commitment_id: id }, (input) =>
    retireCommitment(input as Parameters<typeof retireCommitment>[0]),
  );
}
