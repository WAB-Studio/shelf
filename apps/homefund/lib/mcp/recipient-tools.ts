import "server-only";

import type { CallToolResult, McpServer, ServerContext } from "@modelcontextprotocol/server";
import { z } from "zod";

import { deleteRecipient, listRecipients, saveRecipient } from "@/db/queries/recipients";
import { ActionError } from "@/lib/errors";
import { parseForm } from "@/lib/mcp/parse-form";
import { RECIPIENT_KINDS, deleteRecipientSchema, saveRecipientSchema } from "@/lib/validation/recipient";

type Run = (ctx: ServerContext, load: (owner: string) => Promise<unknown>) => Promise<CallToolResult>;
type Say = (key: string) => string;

// RF-189: the numbers a bank message names, remembered with a name and what they are. Claude asks the
// person once what an unknown number is and saves it here after their yes; the inbox then reads it.
export function registerRecipientTools(server: McpServer, run: Run, t: Say): void {
  const d = (key: string) => t(`params.${key}`);

  server.registerTool(
    "list_recipients",
    { description: t("tools.listRecipients"), inputSchema: z.object({}), annotations: { readOnlyHint: true } },
    (_input, ctx) => run(ctx, () => listRecipients()),
  );

  server.registerTool(
    "save_recipient",
    {
      description: t("tools.saveRecipient"),
      inputSchema: z.object({
        id: z.string().optional().describe(d("recipientId")),
        identifier: z.string().describe(d("recipientIdentifier")),
        name: z.string().describe(d("recipientName")),
        kind: z.enum(RECIPIENT_KINDS).describe(d("recipientKind")),
        accountId: z.string().nullish().describe(d("recipientAccountId")),
        categoryId: z.string().nullish().describe(d("recipientCategoryId")),
      }),
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true },
    },
    (input, ctx) => run(ctx, () => saveRecipient(parseForm(saveRecipientSchema, input))),
  );

  server.registerTool(
    "delete_recipient",
    {
      description: t("tools.deleteRecipient"),
      inputSchema: z.object({ id: z.string().describe(d("recipientId")) }),
      annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true },
    },
    (input, ctx) =>
      run(ctx, async () => {
        const { id } = parseForm(deleteRecipientSchema, input);
        if (!(await deleteRecipient(id))) throw new ActionError("errors.notFound");
        return { deleted: id };
      }),
  );
}
