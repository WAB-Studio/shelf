import { z } from "zod";

import { CHAT_TURNS_SENT, type ChatTurn } from "./types";

// The conversation lives in the tab and nowhere else (RP-94): one key, read by
// every subscriber, written after every turn and every change's state.
const KEY = "pulsar.chat";


const storedChangeSchema = z.object({
  id: z.string(),
  tool: z.string(),
  input: z.record(z.string(), z.unknown()),
  state: z.enum(["open", "made", "refused", "lapsed"]),
  // The sentence of the change, as the route described it; absent on a refused one.
  words: z.object({ key: z.string(), values: z.record(z.string(), z.string()) }).optional(),
  // Why it was refused: a catalogue key (the route's) or a sentence (the act's).
  reason: z.union([z.object({ key: z.string() }), z.object({ text: z.string() })]).optional(),
});

const storedTurnSchema = z.discriminatedUnion("role", [
  z.object({ role: z.literal("person"), text: z.string() }),
  z.object({ role: z.literal("chat"), text: z.string(), changes: z.array(storedChangeSchema) }),
]);

export type StoredChange = z.infer<typeof storedChangeSchema>;
export type StoredTurn = z.infer<typeof storedTurnSchema>;

export const NO_TURNS: StoredTurn[] = [];

const listeners = new Set<() => void>();
let cachedRaw: string | null = null;
let cachedTurns: StoredTurn[] = NO_TURNS;

function raw(): string | null {
  try {
    return window.sessionStorage.getItem(KEY);
  } catch {
    return null;
  }
}

// The same array for the same stored text, so a subscriber re-renders only on a real change.
export function readTurns(): StoredTurn[] {
  const text = raw();
  if (text === cachedRaw) return cachedTurns;
  cachedRaw = text;
  const parsed = text === null ? null : z.array(storedTurnSchema).safeParse(safeJson(text));
  cachedTurns = parsed?.success ? parsed.data : NO_TURNS;
  return cachedTurns;
}

function safeJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

export function subscribeTurns(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

export function updateTurns(change: (turns: StoredTurn[]) => StoredTurn[]): void {
  const next = change(readTurns());
  try {
    window.sessionStorage.setItem(KEY, JSON.stringify(next));
  } catch {
    // A tab that refuses storage keeps the page it has; the next read starts empty.
  }
  listeners.forEach((listener) => listener());
}

// What the model reads: the last turns only, an unmade change counted as open.
export function requestTurns(turns: StoredTurn[]): ChatTurn[] {
  return turns.slice(-CHAT_TURNS_SENT).map((turn) =>
    turn.role === "person"
      ? turn
      : {
          role: "chat",
          text: turn.text,
          changes: turn.changes.map(({ tool, input, state }) => ({
            tool,
            input,
            state: state === "made" ? "made" : state === "refused" ? "refused" : "open",
          })),
        },
  );
}

// A message the chat did not take (shut, or refused as invalid) leaves no turn behind to be sent again.
export function dropUnanswered(turns: StoredTurn[]): StoredTurn[] {
  return turns.at(-1)?.role === "person" ? turns.slice(0, -1) : turns;
}
