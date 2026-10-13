"use server";

import { z } from "zod";

import { errorOf } from "@/lib/mcp/errors";
import { getPerson } from "@/lib/session";
import { writeTool } from "@/lib/tools/catalogue";

export type ChatChangeResult = { ok: true } | { ok: false; key: string; message: string };

const makeChatChangeSchema = z.object({ tool: z.string(), input: z.record(z.string(), z.unknown()) });

const refusal = (key: string): ChatChangeResult => ({ ok: false, ...errorOf(key) });

/**
 * Makes one change the chat proposed (RP-92), on the person's «Hacer». It opens
 * no write path of its own: the act is the catalogue's, so its refusal is the
 * one `/mcp` answers. A tool outside the write catalogue runs nothing.
 */
export async function makeChatChange(input: unknown): Promise<ChatChangeResult> {
  const parsed = makeChatChangeSchema.safeParse(input);
  if (!parsed.success) return refusal("chat.errors.notAllowed");

  if (!(await getPerson())) return refusal("chat.errors.signedOut");

  const spec = writeTool(parsed.data.tool);
  if (!spec) return refusal("chat.errors.notAllowed");
  const args = spec.input.safeParse(parsed.data.input);
  if (!args.success) return refusal("chat.errors.notAllowed");

  const outcome = await spec.run(args.data as Record<string, unknown>);
  return outcome.ok ? { ok: true } : { ok: false, ...errorOf(outcome.error, outcome.values) };
}
