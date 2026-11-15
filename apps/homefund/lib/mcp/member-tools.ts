import "server-only";

import type { CallToolResult, McpServer, ServerContext } from "@modelcontextprotocol/server";
import { z } from "zod";

import { listCallerMembers } from "@/db/queries/group-members";
import { getUserGroup } from "@/db/queries/groups";
import {
  addMember,
  archiveMemberChecked,
  renameMember,
  requireGroupId,
  restoreMemberChecked,
  updateFund,
} from "@/db/queries/member-write";
import { ActionError } from "@/lib/errors";
import { ADD, OVERWRITE, previousFields, titled } from "@/lib/mcp/annotations";
import { parseForm } from "@/lib/mcp/parse-form";
import { OFFERED_CURRENCIES } from "@/lib/currency";
import { GROUP_CASH_MODES, updateGroupSchema } from "@/lib/validation/group";
import { archiveMemberSchema, createMemberSchema, restoreMemberSchema, updateMemberSchema } from "@/lib/validation/member";

type Run = (ctx: ServerContext, load: (owner: string) => Promise<unknown>) => Promise<CallToolResult>;
type Say = (key: string) => string;

// RF-237: the Miembros screen's writes that send no mail, and the fund's settings, through their own schemas and write
// functions. Only the leader writes them (RF-100). A member is created with no email: an invitation is the person's to send.
export function registerMemberTools(server: McpServer, run: Run, t: Say): void {
  const d = (key: string) => t(`params.${key}`);
  const memberId = z.string().describe(d("memberId"));

  server.registerTool(
    "create_member",
    {
      ...titled(t, "createMember"),
      description: t("tools.createMember"),
      inputSchema: z.object({ name: z.string().describe(d("memberName")) }),
      annotations: ADD,
    },
    (input: { name: string }, ctx) =>
      run(ctx, async () => {
        const { name } = parseForm(createMemberSchema, { name: input.name });
        return addMember({ groupId: await requireGroupId(), name });
      }),
  );

  server.registerTool(
    "rename_member",
    {
      ...titled(t, "renameMember"),
      description: t("tools.renameMember"),
      inputSchema: z.object({ memberId, name: z.string().describe(d("memberName")) }),
      annotations: OVERWRITE,
    },
    (input: { memberId: string; name: string }, ctx) =>
      run(ctx, async (owner) => {
        const form = parseForm(updateMemberSchema, { memberId: input.memberId, name: input.name });
        const groupId = await requireGroupId();
        const before = (await listCallerMembers(owner, { archived: "all" })).find((row) => row.id === form.memberId);
        await renameMember({ groupId, memberId: form.memberId, name: form.name });
        return { memberId: form.memberId, before: { name: before?.name ?? null } };
      }),
  );

  for (const [tool, key, schema, write] of [
    ["archive_member", "archiveMember", archiveMemberSchema, archiveMemberChecked],
    ["restore_member", "restoreMember", restoreMemberSchema, restoreMemberChecked],
  ] as const) {
    server.registerTool(
      tool,
      { ...titled(t, key), description: t(`tools.${key}`), inputSchema: z.object({ memberId }), annotations: OVERWRITE },
      (input: { memberId: string }, ctx) =>
        run(ctx, async () => {
          const form = parseForm(schema, input);
          await write({ groupId: await requireGroupId(), memberId: form.memberId });
          return { memberId: form.memberId };
        }),
    );
  }

  server.registerTool(
    "update_fund",
    {
      ...titled(t, "updateFund"),
      description: t("tools.updateFund"),
      inputSchema: z.object({
        name: z.string().optional().describe(d("fundName")),
        cashMode: z.enum(GROUP_CASH_MODES).optional().describe(d("fundCashMode")),
        currency: z.enum(OFFERED_CURRENCIES).optional().describe(d("fundCurrency")),
      }),
      annotations: OVERWRITE,
    },
    (input, ctx) =>
      run(ctx, async () => {
        const current = await getUserGroup();
        if (!current) throw new ActionError("errors.notFound");
        await updateFund(
          parseForm(updateGroupSchema, {
            name: input.name ?? current.name,
            cashMode: input.cashMode ?? current.cashMode,
            currency: input.currency ?? current.currency,
          }),
          "es",
        );
        return { before: previousFields({ name: current.name, cashMode: current.cashMode, currency: current.currency }, input) };
      }),
  );
}
