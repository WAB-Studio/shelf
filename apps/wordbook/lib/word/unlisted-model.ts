import "server-only";

import { z } from "zod";

import { env } from "@/lib/env";
import { providerFetch } from "@/lib/provider/fetch";
import { MODEL_NAME } from "@/lib/word/model";

const CHAT_COMPLETIONS_ENDPOINT = "https://api.openai.com/v1/chat/completions";

// Same reasoning effort and token cap as `lib/word/model.ts`: this route asks
// a third field while reasoning about a word it has no entry for.
// "coccidiosis" spends 576 reasoning tokens and "swishing" 1,024, so a cap
// of 1,000 or less leaves no content on `finish_reason: "length"`.
const REASONING_EFFORT = "low";
const MAX_OUTPUT_TOKENS = 2000;

// What the model itself must produce. `lemma`/`rule` are never asked for —
// `lookupWord` already knows them, and asking the model to echo them back
// is one more way for it to invent an answer instead of translating one.
const modelAnswerSchema = z.object({
  translations: z.array(z.string().min(1)).min(1),
  definition: z.string().min(1).nullable(),
  example: z.object({
    en: z.string().min(1),
    es: z.string().min(1),
  }),
});
type ModelAnswer = z.infer<typeof modelAnswerSchema>;

type ChatCompletionsPayload = {
  choices?: Array<{ message?: { content?: string } }>;
};

// Strict structured outputs: every key required; `modelAnswerSchema` still judges the answer.
const UNLISTED_JSON_SCHEMA = {
  type: "object",
  properties: {
    translations: { type: "array", minItems: 1, items: { type: "string" } },
    definition: { type: ["string", "null"] },
    example: {
      type: "object",
      properties: { en: { type: "string" }, es: { type: "string" } },
      required: ["en", "es"],
      additionalProperties: false,
    },
  },
  required: ["translations", "definition", "example"],
  additionalProperties: false,
};

export type UnlistedInflection = { lemma: string; rule: string };

function buildSystemPrompt(word: string, inflection: UnlistedInflection | null): string {
  if (inflection) {
    // The lemma is context, never the answer: the reader typed the form, and
    // a translation of "swish" where they typed "swishing" is the wrong word.
    return (
      `You extend an English-Spanish learner's dictionary. The word "${word}" is not a headword ` +
      `itself: it is the headword "${inflection.lemma}" inflected. "translations" holds ` +
      `one or more Spanish translations of "${word}" exactly as written — in its own tense and ` +
      `number, never the lemma's dictionary form. Set "definition" to null: a form is not defined ` +
      `on its own. "example.en" is one natural English sentence that uses "${word}" exactly as ` +
      `written. "example.es" is its Spanish translation.`
    );
  }
  return (
    `You extend an English-Spanish learner's dictionary. "${word}" has no entry in it at all. ` +
    `"translations" holds one or more Spanish translations of "${word}", most common ` +
    `first. "definition" is one concise English sentence defining "${word}", in a dictionary's ` +
    `own register. "example.en" is one natural English sentence that uses "${word}". "example.es" ` +
    `is its Spanish translation.`
  );
}

/**
 * Never throws: any failure, at any step, answers `null`, so the route's own
 * 204 is the only way a bad generation reaches a reader — the same contract
 * `generateWordText` (`lib/word/model.ts`) keeps for the text route.
 */
export async function generateUnlistedAnswer(
  word: string,
  inflection: UnlistedInflection | null,
): Promise<ModelAnswer | null> {
  const apiKey = env.OPENAI_API_KEY;
  if (!apiKey) return null;

  const body = {
    model: MODEL_NAME,
    reasoning_effort: REASONING_EFFORT,
    max_completion_tokens: MAX_OUTPUT_TOKENS,
    response_format: {
      type: "json_schema",
      json_schema: { name: "unlisted_word", schema: UNLISTED_JSON_SCHEMA, strict: true },
    },
    messages: [
      { role: "system", content: buildSystemPrompt(word, inflection) },
      { role: "user", content: `Word: ${word}` },
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
    { name: "openai-unlisted" },
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

  const result = modelAnswerSchema.safeParse(parsedContent);
  if (!result.success) return null;
  // A form's definition is never the model's to give: forced null here too,
  // so a prompt the model ignored can never smuggle one into the response.
  return inflection ? { ...result.data, definition: null } : result.data;
}
