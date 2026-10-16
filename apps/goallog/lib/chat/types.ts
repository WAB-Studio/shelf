import { z } from "zod";

// The last 20 turns go to the model; older ones stay on screen only.
export const CHAT_TURNS_SENT = 20;

export const TURN_TEXT_MAX = 2000;
export const REQUEST_TURNS_MAX = 40;

// An answer is bounded by the model's 4000 completion tokens, reasoning included: 12000 characters
// leaves margin. The turns that reach the model sum to at most ten answers and ten questions.
export const CHAT_TEXT_MAX = 12_000;
export const SENT_TEXT_MAX = 150_000;
export const CHANGES_MAX = 50;
export const CHANGE_INPUT_MAX = 8000;
export const REQUEST_BYTES_MAX = 1024 * 1024;

const changeStateSchema = z.enum(["open", "made", "refused"]);

export const chatTurnSchema = z.discriminatedUnion("role", [
  z.object({ role: z.literal("person"), text: z.string().min(1).max(TURN_TEXT_MAX) }),
  z.object({
    role: z.literal("chat"),
    text: z.string().max(CHAT_TEXT_MAX),
    changes: z
      .array(
        z.object({
          tool: z.string().max(100),
          input: z.record(z.string(), z.unknown()).refine((v) => JSON.stringify(v).length <= CHANGE_INPUT_MAX),
          state: changeStateSchema,
        }),
      )
      .max(CHANGES_MAX),
  }),
]);

export type ChatTurn = z.infer<typeof chatTurnSchema>;

export const chatRequestSchema = z.object({
  turns: z
    .array(chatTurnSchema)
    .min(1)
    .max(REQUEST_TURNS_MAX)
    .refine((turns) => turns.at(-1)?.role === "person", "the last turn is the person's")
    .refine(
      (turns) => turns.slice(-CHAT_TURNS_SENT).reduce((sum, turn) => sum + turn.text.length, 0) <= SENT_TEXT_MAX,
      "the turns sent are too long",
    ),
});

export type Change = { id: string; tool: string; input: Record<string, unknown> };
