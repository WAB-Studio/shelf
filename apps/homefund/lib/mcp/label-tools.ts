import "server-only";

import type { CallToolResult, McpServer, ServerContext } from "@modelcontextprotocol/server";
import { z } from "zod";

import { getUserGroup } from "@/db/queries/groups";
import { createLabel, getLabelsScreenData, listScopedLabels, listUsedLabelColors, updateLabel } from "@/db/queries/labels";
import type { LabelScope } from "@/db/queries/labels";
import { pgErrorCode } from "@/lib/db-error";
import { ActionError } from "@/lib/errors";
import { nextCategoryColor } from "@/lib/fund/category-color";
import { parseForm } from "@/lib/mcp/parse-form";
import { createLabelSchema, LABEL_PLACEMENTS, updateLabelSchema } from "@/lib/validation/label";

type Run = (ctx: ServerContext, load: (owner: string) => Promise<unknown>) => Promise<CallToolResult>;
type Say = (key: string) => string;

// What a movement's `labels` input names: an id from `list_labels` or a label's name, read as the picker
// offers them (the person's own and their fund's). A name that no label, or two labels, wear is refused:
// Claude is told to pass the id then. Whether the labels fit the movement's scope is the database's call, as in the form.
export async function resolveLabelIds(owner: string, refs: readonly string[]): Promise<string[]> {
  if (refs.length === 0) return [];
  const known = await listScopedLabels(owner);
  const ids = refs.map((ref) => {
    const wanted = ref.trim();
    const byId = z.uuid().safeParse(wanted).success ? known.find((label) => label.id === wanted) : undefined;
    const matches = byId ? [byId] : known.filter((label) => label.name.toLowerCase() === wanted.toLowerCase());
    if (matches.length !== 1) throw new ActionError("transactions.errors.labelInvalid");
    return matches[0].id;
  });
  return [...new Set(ids)];
}

// A denied write on a group's label says who governs it, as the Labels screen does (RF-70).
function rethrowLabelError(error: unknown): never {
  if (pgErrorCode(error) === "42501") throw new ActionError("errors.notLeader");
  throw error;
}

// RF-193: the Labels screen's lists and writes, through its queries and schemas. Claude never deletes a label.
export function registerLabelTools(server: McpServer, run: Run, t: Say): void {
  const d = (key: string) => t(`params.${key}`);

  server.registerTool(
    "list_labels",
    { description: t("tools.listLabels"), inputSchema: z.object({}), annotations: { readOnlyHint: true } },
    (_input, ctx) =>
      run(ctx, async () => {
        const data = await getLabelsScreenData();
        const row = (scope: "personal" | "fund", canManage: boolean) => (label: (typeof data.personal)[number]) => ({
          id: label.id,
          name: label.name,
          color: label.color,
          scope,
          movementCount: label.movementCount,
          budgetCount: label.budgetCount,
          canManage,
        });
        return [...data.personal.map(row("personal", true)), ...data.group.map(row("fund", data.isLeader))];
      }),
  );

  server.registerTool(
    "create_label",
    {
      description: t("tools.createLabel"),
      inputSchema: z.object({
        name: z.string().describe(d("labelName")),
        placement: z.enum(LABEL_PLACEMENTS).default("personal").describe(d("labelPlacement")),
        color: z.string().optional().describe(d("labelColor")),
      }),
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false },
    },
    (input, ctx) =>
      run(ctx, async (owner) => {
        let scope: LabelScope = { ownerUserId: owner };
        if (input.placement === "group") {
          const group = await getUserGroup();
          if (!group) throw new ActionError("errors.notFound");
          scope = { groupId: group.id };
        }
        const color = input.color ?? nextCategoryColor(await listUsedLabelColors(scope));
        const { name, color: validColor } = parseForm(createLabelSchema, { name: input.name, placement: input.placement, color });
        try {
          return await createLabel({ scope, name, color: validColor });
        } catch (error) {
          return rethrowLabelError(error);
        }
      }),
  );

  server.registerTool(
    "update_label",
    {
      description: t("tools.updateLabel"),
      inputSchema: z.object({
        labelId: z.string().describe(d("labelId")),
        name: z.string().optional().describe(d("labelName")),
        color: z.string().optional().describe(d("labelColor")),
      }),
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true },
    },
    (input, ctx) =>
      run(ctx, async (owner) => {
        const current = (await listScopedLabels(owner)).find((label) => label.id === input.labelId);
        if (!current) throw new ActionError("errors.notFound");
        const args = parseForm(updateLabelSchema, {
          labelId: input.labelId,
          name: input.name ?? current.name,
          color: input.color ?? current.color,
        });
        let updated: boolean;
        try {
          updated = await updateLabel(args);
        } catch (error) {
          return rethrowLabelError(error);
        }
        if (!updated) throw new ActionError("errors.notFound");
        return { labelId: args.labelId };
      }),
  );
}
