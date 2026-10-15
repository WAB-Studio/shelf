import "server-only";

import { lookupWord } from "@/lib/dictionary/lookup";
import { env } from "@/lib/env";
import { admitWord } from "@/lib/word/admit";
import { claimClientCall, clientKey } from "@/lib/word/client-budget";
import { loadDictionaryIndex } from "@/lib/word/dictionary-index";
import { MODEL_NAME } from "@/lib/word/model";
import { claimDailyCall } from "@/lib/word/spend";
import { generateUnlistedAnswer } from "@/lib/word/unlisted-model";
import { readCachedAnswer, writeCachedAnswer } from "@/lib/word/unlisted-cache";
import { unlistedRequestSchema, unlistedResponseSchema } from "@/lib/word/unlisted-protocol";

// RL-44 and RL-47's server half: no reader session reaches this route, the
// cache is keyed on the word alone (`db/schema/word-answers.ts`), and its
// answer is never a candidate for the full route cache.
export const dynamic = "force-dynamic";

// Above the provider's own 20 s timeout.
export const maxDuration = 30;

const NO_STORE = { "Cache-Control": "no-store" };

function json(body: unknown, status: number): Response {
  return Response.json(body, { status, headers: NO_STORE });
}

function empty(status: 204 | 400): Response {
  return new Response(null, { status, headers: NO_STORE });
}

export async function POST(request: Request): Promise<Response> {
  let raw: unknown;
  try {
    raw = await request.json();
  } catch {
    return empty(400);
  }

  const parsed = unlistedRequestSchema.safeParse(raw);
  if (!parsed.success) {
    return empty(400);
  }

  // `admitWord` runs before a single byte reaches the network or the
  // database: a caller feeding it a sentence, a digit or punctuation meant
  // to break out of SQL never gets past this line.
  const word = admitWord(parsed.data.word);
  if (!word) {
    return empty(400);
  }

  // A word the index already carries an exact entry for belongs to
  // `/api/word/text`, never here — this route answers only what the
  // dictionary has nothing at all to say about.
  const answer = lookupWord(loadDictionaryIndex(), word);
  if (answer.exact) {
    return empty(400);
  }

  // The best-ranked inflection `lookupWord` found, if the word is a form of
  // a lemma the dictionary does carry — `null` when it is unlisted outright.
  const inflection = answer.viaInflection[0] ?? null;

  let cached: Awaited<ReturnType<typeof readCachedAnswer>>;
  try {
    cached = await readCachedAnswer(word);
  } catch (error) {
    console.error("[api/word/unlisted] cache read failed", error);
    return empty(204);
  }
  if (cached) {
    return json(unlistedResponseSchema.parse(cached), 200);
  }

  // Absence is one shape everywhere: no key, no per-caller cap, no global
  // cap, no salt to key a caller by, over either cap, a provider failure or
  // a generation that fails to validate all answer `204` — the same
  // "no connection" screen already drawn (RL-35).
  if (!env.OPENAI_API_KEY || !env.WORD_UNLISTED_DAILY_CLIENT_CAP || !env.WORD_TEXT_DAILY_CALL_CAP) {
    return empty(204);
  }

  const client = clientKey(request);
  if (!client) {
    return empty(204);
  }

  try {
    if (!(await claimClientCall(client, env.WORD_UNLISTED_DAILY_CLIENT_CAP))) {
      return empty(204);
    }
  } catch (error) {
    console.error("[api/word/unlisted] client claim failed", error);
    return empty(204);
  }

  // The global cap `/api/word/text` already spends against: one model, one
  // daily budget, whichever route claims it first (docs/TRAPS.md, "The
  // OpenAI CSV does not say what this app spent").
  try {
    if (!(await claimDailyCall(env.WORD_TEXT_DAILY_CALL_CAP))) {
      return empty(204);
    }
  } catch (error) {
    console.error("[api/word/unlisted] daily claim failed", error);
    return empty(204);
  }

  const generated = await generateUnlistedAnswer(
    word,
    inflection ? { lemma: inflection.lemma, rule: inflection.rule } : null,
  );
  if (!generated) {
    return empty(204);
  }

  const lemma = inflection?.lemma ?? null;
  const rule = inflection?.rule ?? null;

  try {
    await writeCachedAnswer(
      word,
      lemma,
      rule,
      generated.translations,
      generated.definition,
      generated.example.en,
      generated.example.es,
      MODEL_NAME,
    );
  } catch (error) {
    console.error("[api/word/unlisted] cache write failed", error);
  }

  return json(
    unlistedResponseSchema.parse({
      translations: generated.translations,
      definition: generated.definition,
      example: generated.example,
      lemma,
      rule,
    }),
    200,
  );
}
