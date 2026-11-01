import "server-only";

import { env } from "@/lib/env";
import { refuseCrossSiteRequest } from "@/lib/word/same-origin";
import { providerFetch } from "@/lib/provider/fetch";
import { cleanProviderText } from "@/lib/translate/clean";
import { isEcho } from "@/lib/translate/echo";
import { containsBlockedTerm } from "@/lib/translate/blocklist";
import { translateRequestSchema, type TranslationResult } from "@/lib/translate/types";
import { claimCallerShare } from "@/lib/word/caller-share";
import { claimClientCall, clientKey, scopedClientKey } from "@/lib/word/client-budget";
import { MODEL_NAME } from "@/lib/word/model";
import { logDark } from "@/lib/word/dark";
import { claimDailyCall } from "@/lib/word/spend";

// The word path never reaches this route (RL-09): it exists for the sentence
// path alone, and only when the device offers no translator of its own.

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

// The provider's JSON is not trusted: anything but a string says nothing, and a string is cleaned of its entities.
function cleanCandidate(value: unknown): string | undefined {
  return typeof value === "string" ? cleanProviderText(value) : undefined;
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

  // Cleaned before the gate, so an echo or a blocked term hiding behind an entity is still caught.
  const translated = cleanCandidate(payload.responseData?.translatedText);
  if (isUsableTranslation(text, translated)) {
    return translated;
  }

  const alternative = bestAlternativeTranslation(
    text,
    Array.isArray(payload.matches)
      ? payload.matches.map((match) => ({ ...match, translation: cleanCandidate(match?.translation) }))
      : undefined,
  );
  if (alternative) {
    return alternative;
  }

  throw new Error("MyMemory returned no usable translation");
}

// RL-60: the model translates first, inside the daily cap the word routes
// share. Null on any reason not to answer (no key, no cap, no caller to
// charge, cap spent, failure, empty or echoed reply) so the caller falls to
// MyMemory; each reason leaves one log line, never the sentence.
async function translateWithModel(request: Request, text: string): Promise<string | null> {
  const apiKey = env.OPENAI_API_KEY;
  if (!apiKey) {
    logDark("translate", "no-key");
    return null;
  }
  if (!env.WORD_TEXT_DAILY_CALL_CAP) {
    logDark("translate", "no-cap");
    return null;
  }
  // A caller nobody can charge never reaches the model.
  const caller = clientKey(request);
  if (!caller) {
    logDark("translate", "no-caller");
    return null;
  }
  // A database error is one more reason not to answer: MyMemory is tried.
  try {
    if (!(await claimCallerShare(caller, env.WORD_TEXT_DAILY_CALL_CAP))) {
      logDark("translate", "caller-share");
      return null;
    }
    if (!(await claimDailyCall(env.WORD_TEXT_DAILY_CALL_CAP))) {
      logDark("translate", "day-cap");
      return null;
    }
  } catch (error) {
    console.error("[api/translate] daily claim failed", error);
    logDark("translate", "claim-error");
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
  if (!response) {
    logDark("translate", "model-failed");
    return null;
  }
  try {
    const payload = (await response.json()) as { choices?: { message?: { content?: unknown } }[] };
    const content = payload.choices?.[0]?.message?.content;
    const out = typeof content === "string" ? cleanProviderText(content) : "";
    if (out && !isEcho(text, out)) return out;
  } catch {
    // An unreadable body is a failed model call, logged below.
  }
  logDark("translate", "model-failed");
  return null;
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
