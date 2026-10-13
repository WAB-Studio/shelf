import "server-only";

import { env } from "@/lib/env";
import { providerFetch } from "@/lib/provider/fetch";
import { notesResponseSchema, type PhraseNoteAnswer } from "@/lib/phrase/notes-protocol";

// RL-46's one model: the cheapest tier, never a flagship, never "minimal"
// reasoning.
export const NOTES_MODEL_NAME = "gpt-5-nano";

const CHAT_COMPLETIONS_ENDPOINT = "https://api.openai.com/v1/chat/completions";
const REASONING_EFFORT = "low";
// Measured on `black minorca pullets`: even at "low", reasoning alone spent
// 700-704 of a 700-token budget and left nothing for the JSON itself —
// `finish_reason: "length"`, empty content, an honest 204 for a call that
// had already answered correctly. This prompt's two hints and the
// three-note shape reason longer than `word/model.ts`'s single headword
// ever did; 1600 leaves headroom above the worst reasoning spend measured.
const MAX_OUTPUT_TOKENS = 1600;

type ChatCompletionsPayload = {
  choices?: Array<{ message?: { content?: string } }>;
};

// Strict structured outputs take `maxItems` but no string length: those ride in
// `description`, and `notesResponseSchema` still judges them.
const NOTES_JSON_SCHEMA = {
  type: "object",
  properties: {
    notes: {
      type: "array",
      maxItems: 3,
      items: {
        type: "object",
        properties: {
          term: { type: "string", description: "Copied verbatim from the English sentence; at most 64 characters." },
          note: { type: "string", description: "In Spanish; at most 280 characters." },
        },
        required: ["term", "note"],
        additionalProperties: false,
      },
    },
  },
  required: ["notes"],
  additionalProperties: false,
};

// The two hints the server computes and hands over as hints, never as
// instructions — the contract's own example (`black minorca`) is the case
// neither hint touches, and only the model's read of the whole sentence
// resolves it.
function buildSystemPrompt(survivors: string[], unindexed: string[]): string {
  const hintLines: string[] = [];
  if (survivors.length > 0) {
    hintLines.push(
      `Source words that survive unchanged inside the translation: ${survivors.join(", ")}.`,
    );
  }
  if (unindexed.length > 0) {
    hintLines.push(
      `Source words this dictionary's own index carries no entry for: ${unindexed.join(", ")}.`,
    );
  }
  const hintBlock =
    hintLines.length > 0
      ? ` ${hintLines.join(" ")} Treat both as hints, not as a checklist: ignore either when the ` +
        `sentence's own context points to a different term, or to none at all.`
      : "";

  return (
    `You help a Spanish-speaking learner of English who already has an English sentence and its ` +
    `Spanish translation. Pick up to three terms from the English sentence that this reader would ` +
    `not recognise — a breed, a place, a custom, a thing — and write one short note in Spanish for ` +
    `each explaining what the thing is, never how the word translates: a note on "black minorca" ` +
    `says it is a chicken breed, not that "minorca" means "menorca".${hintBlock} Zero notes is a ` +
    `correct answer when nothing in the sentence needs one — never invent a term to fill three ` +
    `slots. Copy each "term" verbatim from the English sentence and write each "note" in Spanish.`
  );
}

/**
 * One call, up to three notes. Never throws: any failure, at any step,
 * answers `null`, so the route's own 204 is the only way a bad generation
 * reaches a reader (mirrors `generateWordText`).
 */
export async function generateNotes(
  source: string,
  translation: string,
  survivors: string[],
  unindexed: string[],
): Promise<PhraseNoteAnswer[] | null> {
  const apiKey = env.OPENAI_API_KEY;
  if (!apiKey) return null;

  const body = {
    model: NOTES_MODEL_NAME,
    reasoning_effort: REASONING_EFFORT,
    max_completion_tokens: MAX_OUTPUT_TOKENS,
    response_format: {
      type: "json_schema",
      json_schema: { name: "phrase_notes", schema: NOTES_JSON_SCHEMA, strict: true },
    },
    messages: [
      { role: "system", content: buildSystemPrompt(survivors, unindexed) },
      { role: "user", content: `English: ${source}\nSpanish: ${translation}` },
    ],
  };

  const response = await providerFetch(
    CHAT_COMPLETIONS_ENDPOINT,
    {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${apiKey}`,
      },
      body: JSON.stringify(body),
    },
    { name: "openai-notes" },
  );
  if (!response) return null;

  let payload: ChatCompletionsPayload;
  try {
    payload = (await response.json()) as ChatCompletionsPayload;
  } catch {
    return null;
  }

  const content = payload.choices?.[0]?.message?.content;
  if (typeof content !== "string") return null;

  let parsedContent: unknown;
  try {
    parsedContent = JSON.parse(content);
  } catch {
    return null;
  }

  const result = notesResponseSchema.safeParse(parsedContent);
  return result.success ? result.data.notes : null;
}
