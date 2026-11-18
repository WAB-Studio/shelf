import "server-only";

import type { CallToolResult, McpServer, ServerContext } from "@modelcontextprotocol/server";
import { z } from "zod";

import { getUserGroup } from "@/db/queries/groups";
import { getOwedToMe } from "@/db/queries/owed-to-me";
import { createLabel, getLabelsScreenData, listScopedLabels, listUsedLabelColors, updateLabel } from "@/db/queries/labels";
import type { LabelScope } from "@/db/queries/labels";
import { pgErrorCode } from "@/lib/db-error";
import { ActionError } from "@/lib/errors";
import { ADD, OVERWRITE, READ, previousFields, titled } from "@/lib/mcp/annotations";
import { nextCategoryColor } from "@/lib/fund/category-color";
import { parseForm } from "@/lib/mcp/parse-form";
import { centsToDecimal } from "@/lib/money";
import { alreadyOwedOf, createLabelSchema, LABEL_PLACEMENTS, updateLabelSchema } from "@/lib/validation/label";

type Run = (ctx: ServerContext, load: (owner: string) => Promise<unknown>) => Promise<CallToolResult>;
type Say = (key: string) => string;

// What a movement's `labels` input names: an id from `list_labels` or a label's name, read as the picker
// offers them (the person's own and their fund's). A name that no label, or two labels, wear is refused:
// Claude is told to pass the id then. Whether the labels fit the movement's scope is the database's call, as in the form.
// A person is no tag: naming one here is refused in words that point at `forPerson` (RF-242).
export async function resolveLabelIds(owner: string, refs: readonly string[]): Promise<string[]> {
  if (refs.length === 0) return [];
  const known = await listScopedLabels(owner);
  const ids = refs.map((ref) => {
    const wanted = ref.trim();
    const byId = z.uuid().safeParse(wanted).success ? known.find((label) => label.id === wanted) : undefined;
    const matches = byId ? [byId] : known.filter((label) => label.name.toLowerCase() === wanted.toLowerCase());
    if (matches.length !== 1) throw new ActionError("transactions.errors.labelInvalid");
    if (matches[0].kind === "person") throw new ActionError("mcp.errors.personIsNotATag");
    return matches[0].id;
  });
  return [...new Set(ids)];
}

// What `forPerson` names: a person's id from `list_persons` or their name, read the same way. A tag is no person.
export async function resolvePersonId(owner: string, ref: string): Promise<string> {
  const known = (await listScopedLabels(owner)).filter((label) => label.kind === "person");
  const wanted = ref.trim();
  const byId = z.uuid().safeParse(wanted).success ? known.find((label) => label.id === wanted) : undefined;
  const matches = byId ? [byId] : known.filter((label) => label.name.toLowerCase() === wanted.toLowerCase());
  if (matches.length !== 1) throw new ActionError("transactions.errors.forPersonInvalid");
  return matches[0].id;
}

// A denied write on a group's label says who governs it, as the Labels screen does (RF-70).
function rethrowLabelError(error: unknown): never {
  if (pgErrorCode(error) === "42501") throw new ActionError("errors.notLeader");
  // What a person already owed needs «se le cobra» on (RF-319): the one check an edit can trip.
  if (pgErrorCode(error) === "23514") throw new ActionError("labels.errors.alreadyOwedNeedsCharge");
  throw error;
}

// `alreadyOwed` as Claude sends it (integer cents), turned into what the form's schema reads (RF-319).
const alreadyOwedInput = z
  .object({ cents: z.number().int(), currency: z.string(), since: z.string() })
  .nullable()
  .optional();

function schemaOwed(value: { cents: number; currency: string; since: string } | null | undefined) {
  return value ? { amount: centsToDecimal(value.cents), currency: value.currency, since: value.since } : value;
}

// What a person owes now, per currency: the answer a write gives back so Claude can say the figure (RF-294).
async function owedNow(labelId: string) {
  const owed = await getOwedToMe();
  return owed.flatMap((group) => group.people.filter((one) => one.labelId === labelId).map((one) => ({ currency: group.currency, cents: one.cents })));
}

const isTag = (label: { kind: string }) => label.kind === "tag";
const isPerson = (label: { kind: string }) => label.kind === "person";

// RF-193: the Labels screen's lists and writes, through its queries and schemas. Claude never deletes a label.
export function registerLabelTools(server: McpServer, run: Run, t: Say): void {
  const d = (key: string) => t(`params.${key}`);

  server.registerTool(
    "list_labels",
    { ...titled(t, "listLabels"), description: t("tools.listLabels"), inputSchema: z.object({}), annotations: READ },
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
        return [...data.personal.filter(isTag).map(row("personal", true)), ...data.group.filter(isTag).map(row("fund", data.isLeader))];
      }),
  );

  // RF-242: the persons a movement can be for, listed apart from the tags so Claude never offers one as the other.
  server.registerTool(
    "list_persons",
    { ...titled(t, "listPersons"), description: t("tools.listPersons"), inputSchema: z.object({}), annotations: READ },
    (_input, ctx) =>
      run(ctx, async () => {
        const [data, owed] = await Promise.all([getLabelsScreenData(), getOwedToMe()]);
        // What each person «se le cobra» still owes, per currency (RF-294); a person who owes nothing has none.
        const owedBy = (id: string) =>
          owed.flatMap((group) => group.people.filter((one) => one.labelId === id).map((one) => ({ currency: group.currency, cents: one.cents })));
        const row = (scope: "personal" | "fund", canManage: boolean) => (person: (typeof data.personal)[number]) => ({
          id: person.id,
          name: person.name,
          color: person.color,
          scope,
          chargeDefault: person.chargeDefault,
          alreadyOwed: person.alreadyOwed,
          owed: owedBy(person.id),
          movementCount: person.movementCount,
          budgetCount: person.budgetCount,
          canManage,
        });
        return [...data.personal.filter(isPerson).map(row("personal", true)), ...data.group.filter(isPerson).map(row("fund", data.isLeader))];
      }),
  );

  server.registerTool(
    "create_person",
    {
      ...titled(t, "createPerson"),
      description: t("tools.createPerson"),
      inputSchema: z.object({
        name: z.string().describe(d("personName")),
        placement: z.enum(LABEL_PLACEMENTS).default("personal").describe(d("labelPlacement")),
        chargeDefault: z.boolean().default(false).describe(d("chargeDefault")),
        alreadyOwed: alreadyOwedInput.describe(d("alreadyOwed")),
        color: z.string().optional().describe(d("labelColor")),
      }),
      annotations: ADD,
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
        const args = parseForm(createLabelSchema, {
          name: input.name,
          placement: input.placement,
          color,
          kind: "person",
          chargeDefault: input.chargeDefault,
          alreadyOwed: schemaOwed(input.alreadyOwed),
        });
        let created: { labelId: string };
        try {
          created = await createLabel({
            scope,
            name: args.name,
            color: args.color,
            kind: "person",
            chargeDefault: args.chargeDefault,
            alreadyOwed: alreadyOwedOf(args.alreadyOwed),
          });
        } catch (error) {
          return rethrowLabelError(error);
        }
        return { ...created, owed: await owedNow(created.labelId) };
      }),
  );

  server.registerTool(
    "create_label",
    {
      ...titled(t, "createLabel"),
      description: t("tools.createLabel"),
      inputSchema: z.object({
        name: z.string().describe(d("labelName")),
        placement: z.enum(LABEL_PLACEMENTS).default("personal").describe(d("labelPlacement")),
        color: z.string().optional().describe(d("labelColor")),
      }),
      annotations: ADD,
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
      ...titled(t, "updateLabel"),
      description: t("tools.updateLabel"),
      inputSchema: z.object({
        labelId: z.string().describe(d("labelId")),
        name: z.string().optional().describe(d("labelName")),
        color: z.string().optional().describe(d("labelColor")),
        chargeDefault: z.boolean().optional().describe(d("chargeDefault")),
        alreadyOwed: alreadyOwedInput.describe(d("alreadyOwed")),
      }),
      annotations: OVERWRITE,
    },
    (input, ctx) =>
      run(ctx, async (owner) => {
        const current = (await listScopedLabels(owner)).find((label) => label.id === input.labelId);
        if (!current) throw new ActionError("errors.notFound");
        const args = parseForm(updateLabelSchema, {
          labelId: input.labelId,
          name: input.name ?? current.name,
          color: input.color ?? current.color,
          chargeDefault: input.chargeDefault,
          alreadyOwed: schemaOwed(input.alreadyOwed),
        });
        let updated: boolean;
        try {
          updated = await updateLabel({ ...args, alreadyOwed: alreadyOwedOf(args.alreadyOwed) });
        } catch (error) {
          return rethrowLabelError(error);
        }
        if (!updated) throw new ActionError("errors.notFound");
        return {
          labelId: args.labelId,
          before: previousFields({ name: current.name, color: current.color, chargeDefault: current.chargeDefault, alreadyOwed: current.alreadyOwed }, input),
          owed: await owedNow(args.labelId),
        };
      }),
  );
}
