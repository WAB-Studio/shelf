"use server";

import { refresh } from "next/cache";

import { deleteRecipient, saveRecipient } from "@/db/queries/recipients";
import { ActionError } from "@/lib/errors";
import { authActionClient } from "@/lib/safe-action";
import { deleteRecipientSchema, saveRecipientSchema } from "@/lib/validation/recipient";

// RF-189: a number a bank message names, saved with a name and what it is.
export const saveRecipientAction = authActionClient
  .inputSchema(saveRecipientSchema)
  .action(async ({ parsedInput }) => {
    const { id } = await saveRecipient(parsedInput);
    refresh();
    return { id };
  });

export const deleteRecipientAction = authActionClient
  .inputSchema(deleteRecipientSchema)
  .action(async ({ parsedInput: { id } }) => {
    if (!(await deleteRecipient(id))) throw new ActionError("errors.notFound");
    refresh();
  });
