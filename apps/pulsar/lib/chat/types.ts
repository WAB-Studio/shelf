import { z } from "zod";

// The last 20 turns go to the model; older ones stay on screen only.
export const CHAT_TURNS_SENT = 20;

export const TURN_TEXT_MAX = 2000;
export const REQUEST_TURNS_MAX = 40;

const changeStateSchema = z.enum(["open", "made", "refused"]);

export const chatTurnSchema = z.discriminatedUnion("role", [
  z.object({ role: z.literal("person"), text: z.string().min(1).max(TURN_TEXT_MAX) }),
  z.object({
    role: z.literal("chat"),
    text: z.string(),
    changes: z.array(
      z.object({ tool: z.string(), input: z.record(z.string(), z.unknown()), state: changeStateSchema }),
    ),
  }),
]);

export type ChatTurn = z.infer<typeof chatTurnSchema>;

export const chatRequestSchema = z.object({
  turns: z
    .array(chatTurnSchema)
    .min(1)
    .max(REQUEST_TURNS_MAX)
    .refine((turns) => turns.at(-1)?.role === "person", "the last turn is the person's"),
});

export type Change = { id: string; tool: string; input: Record<string, unknown> };
