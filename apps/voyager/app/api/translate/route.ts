import "server-only";

import { env } from "@/lib/env";
import { refuseCrossSiteRequest } from "@/lib/word/same-origin";
import { providerFetch } from "@/lib/provider/fetch";
import { containsBlockedTerm } from "@/lib/translate/blocklist";
import { translateRequestSchema, type TranslationResult } from "@/lib/translate/types";
import { claimCallerShare } from "@/lib/word/caller-share";
import { claimClientCall, clientKey, scopedClientKey } from "@/lib/word/client-budget";
import { MODEL_NAME } from "@/lib/word/model";
import { claimDailyCall } from "@/lib/word/spend";

// The word path never reaches this route (RL-09): it exists for the sentence
// path alone, and only when the device offers no translator of its own.
export const dynamic = "force-dynamic";

// The model call may wait its full timeout before MyMemory is tried.
export const maxDuration = 40;

// MyMemory's endpoint and language pair, the one constant a provider swap
// touches. English to Spanish is fixed for this slice; direction is not a
// parameter the route accepts.
const MYMEMORY_ENDPOINT = "https://api.mymemory.translated.net/get";

// Half the OpenAI routes' 20 s: a sentence the reader is waiting on falls to
// RL-59's per-word answer sooner.
const MYMEMORY_TIMEOUT_MS = 10_000;

const MODEL_TIMEOUT_MS = 20_000;

type MyMemoryMatch = {
  translation?: string;
  quality?: string;
  match?: number;
};

type MyMemoryResponse = {
  responseData?: { translatedText?: string };
  responseStatus?: number | string;
  matches?: MyMemoryMatch[];
};

// MyMemory's quota-exhausted warning always starts with this: matched as a
// belt-and-braces check alongside `responseStatus`, in case a future warning
// ships a status this file has not seen.
const MYMEMORY_WARNING_PREFIX = "MYMEMORY WARNING";

// Trim, case-fold, and collapse inner whitespace — the differences a reader
// never notices between what they typed and what came back. Punctuation is
// left alone: a reader who typed a trailing "?" and got one back said
// something, even if the words never moved.
function foldForComparison(s: string): string {
  return s.trim().replace(/\s+/g, " ").toLowerCase();
}

// MyMemory echoes a string it cannot place in either language straight
// back — gibberish included — with `responseStatus: "200"` and no warning:
// the two checks below never catch it. The same fold also refuses a proper
// noun, a brand name or a number that legitimately holds still across `en`
// and `es`; RL-59's per-word breakdown is what that reply lands on instead,
// an honest "could not answer" rather than a false badge.
function isEcho(source: string, translated: string): boolean {
  return foldForComparison(translated) === foldForComparison(source);
}

// The one gate both `responseData.translatedText` and every `matches` entry
// answer to: not empty, not the quota warning, not an echo of what was
// asked, and free of the blocked terms (RL-64). A candidate that fails any of
// these said nothing, whichever field it came from.
function isUsableTranslation(source: string, candidate: string | undefined): candidate is string {
  return (
    typeof candidate === "string" &&
    candidate.length > 0 &&
    !candidate.toUpperCase().startsWith(MYMEMORY_WARNING_PREFIX) &&
    !isEcho(source, candidate) &&
    !containsBlockedTerm(candidate)
  );
}

// MyMemory's top pick can come back empty — measured live for "the cat sat
// on the mat" — while `matches` still holds one that answers the sentence.
// Ranked by `match`, not by array position: the reply is not contractually
// sorted, and the highest-scoring usable entry is the one worth trusting.
function bestAlternativeTranslation(source: string, matches: MyMemoryMatch[] | undefined): string | undefined {
  let best: { translation: string; score: number } | undefined;
  for (const candidate of matches ?? []) {
    if (!isUsableTranslation(source, candidate.translation)) continue;
    const score = candidate.match ?? 0;
    if (!best || score > best.score) {
      best = { translation: candidate.translation, score };
    }
  }
  return best?.translation;
}

// The one function a provider swap replaces. MyMemory's anonymous tier caps
// at roughly 5,000 words a day per caller IP (10,000 once `de` names a
// registered email); past that cap it still answers HTTP 200, with
// `responseStatus` set to a non-200 value (`"160"`) and `translatedText`
// holding a warning sentence, not a translation. Both `responseStatus` and
// the warning's own prefix are checked, so that sentence never reaches a
// reader as though it answered what they typed — the client only ever sees
// a generic 502, never a rate-limit message to parse.
//
// A quota past the cap is a request-level failure and stops here, before
// `matches` is even read: `responseStatus` already said the whole reply is
// not to be trusted, so there is nothing in it worth falling back to.
//
// Below that, an unusable top pick is not the whole reply's failure — RL-60,
// measured live: MyMemory's best-scoring match for "the cat sat on the mat"
// is `translatedText: ""`, while a lower-scoring entry in `matches` answers
// the sentence in full. That array is checked with the same filter before
// this function gives up and lets the route answer 502.
async function translateWithProvider(text: string): Promise<string> {
  const params = new URLSearchParams({ q: text, langpair: "en|es" });
  if (env.TRANSLATE_MYMEMORY_EMAIL) params.set("de", env.TRANSLATE_MYMEMORY_EMAIL);
  if (env.TRANSLATE_MYMEMORY_KEY) params.set("key", env.TRANSLATE_MYMEMORY_KEY);

  const response = await providerFetch(
    `${MYMEMORY_ENDPOINT}?${params.toString()}`,
    {},
    { name: "mymemory", timeoutMs: MYMEMORY_TIMEOUT_MS },
  );
  if (!response) {
    throw new Error("MyMemory failed, timed out or responded with an error status");
  }

  const payload = (await response.json()) as MyMemoryResponse;
  if (String(payload.responseStatus) !== "200") {
    throw new Error("MyMemory reported a non-200 responseStatus");
  }

  const translated = payload.responseData?.translatedText;
  if (isUsableTranslation(text, translated)) {
    return translated;
  }

  const alternative = bestAlternativeTranslation(text, payload.matches);
  if (alternative) {
    return alternative;
  }

  throw new Error("MyMemory returned no usable translation");
}

// RL-60: the model translates first, inside the daily cap the word routes
// share. Null on any reason not to answer (no key, no cap, cap spent, failure,
// empty or echoed reply) so the caller falls to MyMemory.
async function translateWithModel(request: Request, text: string): Promise<string | null> {
  const apiKey = env.OPENAI_API_KEY;
  if (!apiKey || !env.WORD_TEXT_DAILY_CALL_CAP) return null;
  // A database error is one more reason not to answer: MyMemory is tried.
  try {
    const caller = clientKey(request);
    if (caller && !(await claimCallerShare(caller, env.WORD_TEXT_DAILY_CALL_CAP))) return null;
    if (!(await claimDailyCall(env.WORD_TEXT_DAILY_CALL_CAP))) return null;
  } catch (error) {
    console.error("[api/translate] daily claim failed", error);
    return null;
  }
  const response = await providerFetch(
    "https://api.openai.com/v1/chat/completions",
    {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${apiKey}` },
      body: JSON.stringify({
        model: MODEL_NAME,
        reasoning_effort: "low",
        max_completion_tokens: 2000,
        messages: [
          {
            role: "system",
            content: "Translate the English sentence into Spanish. Reply with the translation only; add no words.",
          },
          { role: "user", content: text },
        ],
      }),
    },
    { name: "openai-translate", timeoutMs: MODEL_TIMEOUT_MS },
  );
  if (!response) return null;
  try {
    const payload = (await response.json()) as { choices?: { message?: { content?: unknown } }[] };
    const content = payload.choices?.[0]?.message?.content;
    const out = typeof content === "string" ? content.trim() : "";
    return out && !isEcho(text, out) ? out : null;
  } catch {
    return null;
  }
}

export async function POST(request: Request): Promise<Response> {
  const refused = refuseCrossSiteRequest(request);
  if (refused) return refused;

  let raw: unknown;
  try {
    raw = await request.json();
  } catch {
    return Response.json({ error: "invalid" }, { status: 400 });
  }

  const parsed = translateRequestSchema.safeParse(raw);
  if (!parsed.success) {
    return Response.json({ error: "invalid" }, { status: 400 });
  }

  // Per caller, its own `translate:` row, so a caller's sentences never eat
  // into their word lookups. With no key (no salt, no address) the route
  // stays open: an unset variable must not switch RL-09 off. Refused before
  // MyMemory is reached; the client reads 429 as any other failure (RL-59).
  try {
    const client = scopedClientKey("translate", request.headers);
    if (client && !(await claimClientCall(client, env.TRANSLATE_DAILY_CLIENT_CAP))) {
      return Response.json({ error: "rateLimited" }, { status: 429 });
    }
    const text = (await translateWithModel(request, parsed.data.text)) ?? (await translateWithProvider(parsed.data.text));
    const result: TranslationResult = { text, origin: "network" };
    return Response.json(result, { status: 200 });
  } catch (error) {
    console.error("[api/translate] failed", error);
    return Response.json({ error: "provider" }, { status: 502 });
  }
}
