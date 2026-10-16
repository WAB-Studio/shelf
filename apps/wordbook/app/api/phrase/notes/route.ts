import "server-only";

import { normaliseHeadword } from "@/lib/dictionary/format";
import { groupFor, type DictionaryIndex } from "@/lib/dictionary/index-build";
import { env } from "@/lib/env";
import { empty, json } from "@/lib/http/responses";
import { refuseCrossSiteRequest } from "@/lib/word/same-origin";
import { logDark } from "@/lib/word/dark";
import { claimCallerShare } from "@/lib/word/caller-share";
import { claimClientCall, clientKey } from "@/lib/word/client-budget";
import { loadDictionaryIndex } from "@/lib/word/dictionary-index";
import { claimDailyCall } from "@/lib/word/spend";
import { generateNotes, NOTES_MODEL_NAME } from "@/lib/phrase/notes-model";
import { phraseHash, readCachedNotes, writeCachedNotes } from "@/lib/phrase/notes-cache";
import { admitPhrase, notesRequestSchema, notesResponseSchema, tokenisePhrase } from "@/lib/phrase/notes-protocol";

// This is the first route in the app that sends a reader's own free text to
// a paid provider (every earlier one sends a headword `admitWord` already
// closed, or a caller-chosen but dictionary-listed string). Its gate and its
// budget are written here because nothing upstream of this file has ever
// had to earn either.
export const dynamic = "force-dynamic";

// Above the provider's own 20 s timeout.
export const maxDuration = 30;

// A source token survives translation when the exact same spelling still
// appears as a whole word inside the translation — `frisking` staying
// `frisking` rather than becoming a Spanish verb. Case-insensitive: the
// model capitalising a proper noun differently is not a different word.
function survivingTokens(sourceTokens: string[], translation: string): string[] {
  const translationWords = new Set(tokenisePhrase(translation).map((word) => word.toLowerCase()));
  return sourceTokens.filter((token) => translationWords.has(token.toLowerCase()));
}

function unindexedTokens(index: DictionaryIndex, sourceTokens: string[]): string[] {
  return sourceTokens.filter((token) => groupFor(index, normaliseHeadword(token)) === null);
}

export async function POST(request: Request): Promise<Response> {
  const refused = refuseCrossSiteRequest(request);
  if (refused) return refused;

  let raw: unknown;
  try {
    raw = await request.json();
  } catch {
    return json({ error: "invalid" }, 400);
  }

  const parsed = notesRequestSchema.safeParse(raw);
  if (!parsed.success) {
    return json({ error: "invalid" }, 400);
  }

  const sourceTokens = admitPhrase(parsed.data.source, parsed.data.translation);
  if (!sourceTokens) {
    return json({ error: "invalid" }, 400);
  }

  // The clear phrase never reaches storage: only its hash does, from here
  // on. A cache hit answers with no budget spent and no model reached,
  // whatever the caps below say.
  const hash = phraseHash(parsed.data.source, parsed.data.translation);
  let cached: Awaited<ReturnType<typeof readCachedNotes>>;
  try {
    cached = await readCachedNotes(hash);
  } catch (error) {
    console.error("[api/phrase/notes] cache read failed", error);
    logDark("phrase/notes", "cache-error");
    return empty(204);
  }
  if (cached) {
    return json(notesResponseSchema.parse({ notes: cached }), 200);
  }

  // Absence is one shape everywhere: no key configured, no cap configured,
  // no chargeable client, over either cap, a provider failure, or a
  // generation that fails to validate all answer `204` — the same
  // "no connection" screen already drawn (RL-35).
  if (!env.OPENAI_API_KEY) {
    logDark("phrase/notes", "no-key");
    return empty(204);
  }
  if (!env.PHRASE_NOTES_DAILY_CALL_CAP || !env.PHRASE_NOTES_DAILY_CLIENT_CAP || !env.WORD_TEXT_DAILY_CALL_CAP) {
    logDark("phrase/notes", "no-cap");
    return empty(204);
  }

  // A budget nobody can charge is a budget that does not exist
  // (`client-budget.ts`): with no `CLIENT_KEY_SALT` configured, `clientKey`
  // reads `null` for every caller and this route never reaches the model.
  const client = clientKey(request);
  if (!client) {
    logDark("phrase/notes", "no-caller");
    return empty(204);
  }

  // The same `reading.client_spend` row `/api/word/unlisted` bumps for this
  // caller, read against this route's own ceiling — never against
  // WORD_UNLISTED_DAILY_CLIENT_CAP, and never left unread the way it was.
  try {
    if (!(await claimCallerShare(client, env.WORD_TEXT_DAILY_CALL_CAP))) {
      logDark("phrase/notes", "caller-share");
      return empty(204);
    }
    if (!(await claimClientCall(client, env.PHRASE_NOTES_DAILY_CLIENT_CAP))) {
      logDark("phrase/notes", "caller-cap");
      return empty(204);
    }
  } catch (error) {
    console.error("[api/phrase/notes] client claim failed", error);
    logDark("phrase/notes", "claim-error");
    return empty(204);
  }

  // Sequential, not `Promise.all` with the claim above: run in parallel, a
  // caller already refused would still take one of the day's calls. The
  // day's counter is the one every paid route shares, so its ceiling is the
  // lower of this route's own and the global one: notes never spend past
  // the day `/api/word/text` is held to.
  const dailyCap = Math.min(env.PHRASE_NOTES_DAILY_CALL_CAP, env.WORD_TEXT_DAILY_CALL_CAP);
  try {
    if (!(await claimDailyCall(dailyCap))) {
      logDark("phrase/notes", "day-cap");
      return empty(204);
    }
  } catch (error) {
    console.error("[api/phrase/notes] daily claim failed", error);
    logDark("phrase/notes", "claim-error");
    return empty(204);
  }

  const index = loadDictionaryIndex();
  const survivors = survivingTokens(sourceTokens, parsed.data.translation);
  const unindexed = unindexedTokens(index, sourceTokens);

  const notes = await generateNotes(parsed.data.source, parsed.data.translation, survivors, unindexed);
  if (!notes) {
    logDark("phrase/notes", "model-failed");
    return empty(204);
  }

  try {
    await writeCachedNotes(hash, NOTES_MODEL_NAME, notes);
  } catch (error) {
    console.error(`[api/phrase/notes] cache write failed key=${hash}`, error);
  }

  return json(notesResponseSchema.parse({ notes }), 200);
}
