import "server-only";

import { normaliseHeadword } from "@/lib/dictionary/format";
import { groupFor } from "@/lib/dictionary/index-build";
import { env } from "@/lib/env";
import { empty, json } from "@/lib/http/responses";
import { refuseCrossSiteRequest } from "@/lib/word/same-origin";
import { logDark, type DarkReason } from "@/lib/word/dark";
import { claimCallerShare } from "@/lib/word/caller-share";
import { claimClientCall, clientKey, scopedClientKey } from "@/lib/word/client-budget";
import { wantsDefinition } from "@/lib/word/definition-need";
import { loadDictionaryIndex } from "@/lib/word/dictionary-index";
import { generateWordText, MODEL_NAME } from "@/lib/word/model";
import { textRequestSchema, textResponseSchema } from "@/lib/word/protocol";
import { claimDailyCall } from "@/lib/word/spend";
import {
  markTranslationsAsked,
  readCachedText,
  translationsWereAnswered,
  writeCachedText,
} from "@/lib/word/text-cache";
import { isThinAnswer } from "@/lib/word/thin";

// RL-41 and RL-42's decoration: no reader session reaches this route, the
// cache is keyed on the headword alone (`db/schema/word-texts.ts`).

// Above the provider's own 20 s timeout, so a slow model answers 204 rather
// than the platform killing the function mid-claim.
export const maxDuration = 30;

// The caller's cap, then the day's, in series: run in parallel, a caller
// already refused would still take one of the day's calls. No chargeable
// caller (no salt, no address) reaches the model at all.
async function claimModelCall(
  request: Request,
  dailyCap: number,
): Promise<"ok" | Extract<DarkReason, "no-caller" | "caller-share" | "caller-cap" | "day-cap" | "claim-error">> {
  try {
    const client = scopedClientKey("text", request.headers);
    if (!client) return "no-caller";
    const caller = clientKey(request);
    if (!caller) return "no-caller";
    if (!(await claimCallerShare(caller, dailyCap))) return "caller-share";
    if (!(await claimClientCall(client, env.WORD_TEXT_DAILY_CLIENT_CAP))) return "caller-cap";
    return (await claimDailyCall(dailyCap)) ? "ok" : "day-cap";
  } catch (error) {
    console.error("[api/word/text] claim failed", error);
    return "claim-error";
  }
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

  const parsed = textRequestSchema.safeParse(raw);
  if (!parsed.success) {
    return json({ error: "invalid" }, 400);
  }

  // The closed list the route accepts, checked before the cache read: a
  // headword absent from it never reaches the model, however the caller
  // spells the body.
  const index = loadDictionaryIndex();
  const headword = normaliseHeadword(parsed.data.headword);
  const group = groupFor(index, headword);
  if (!group) {
    return json({ error: "invalid" }, 400);
  }

  const thin = isThinAnswer(group);

  let cached: Awaited<ReturnType<typeof readCachedText>>;
  try {
    cached = await readCachedText(headword);
  } catch (error) {
    console.error("[api/word/text] cache read failed", error);
    logDark("word/text", "cache-error");
    return empty(204);
  }
  if (cached) {
    let translations = cached.translations;
    // A thin word never asked, or asked before this column existed:
    // enrich it in place, at most once per row the model answers. Both caps
    // guard this ask too, but never at the cost of the answer already
    // cached — over either, or with the model off, the row's definition and
    // example still return; only the enrichment is skipped, and it stays
    // open for a later lookup.
    if (thin && !cached.translationsAsked) {
      const dark = !env.OPENAI_API_KEY
        ? "no-key"
        : !env.WORD_TEXT_DAILY_CALL_CAP
          ? "no-cap"
          : await claimModelCall(request, env.WORD_TEXT_DAILY_CALL_CAP);
      if (dark !== "ok") {
        logDark("word/text", dark);
      } else {
        const generated = await generateWordText(headword, false, group.senses);
        translations = generated?.translations ?? null;
        try {
          await markTranslationsAsked(headword, translations);
        } catch (error) {
          console.error(`[api/word/text] cache write failed key=${headword}`, error);
        }
      }
    }
    return json(
      textResponseSchema.parse({
        definition: parsed.data.needDefinition ? cached.definition : null,
        example: cached.example,
        translations,
      }),
      200,
    );
  }

  // Absence is one shape everywhere: no key configured, no cap configured,
  // over the cap, a provider failure, a generation that fails to validate
  // or no chargeable caller all answer `204`, the same "no connection"
  // screen already drawn (RL-35). Each logs its reason.
  if (!env.OPENAI_API_KEY) {
    logDark("word/text", "no-key");
    return empty(204);
  }
  if (!env.WORD_TEXT_DAILY_CALL_CAP) {
    logDark("word/text", "no-cap");
    return empty(204);
  }

  const claim = await claimModelCall(request, env.WORD_TEXT_DAILY_CALL_CAP);
  if (claim !== "ok") {
    logDark("word/text", claim);
    return empty(204);
  }

  // One dictionary definition anywhere in the group is "already has one",
  // whatever the caller's own `needDefinition` claims.
  const wantDefinition = wantsDefinition(parsed.data.needDefinition, group.senses);

  // A thin entry rides this same call: one daily-cap claim for the lookup.
  const generated = await generateWordText(headword, wantDefinition, thin ? group.senses : null);
  if (!generated) {
    logDark("word/text", "model-failed");
    return empty(204);
  }

  const definition = wantDefinition ? generated.definition : null;
  const translations = thin ? generated.translations : null;
  // A thin word the model answered, even with `[]`, is closed; one it left
  // null stays open — the same rule `markTranslationsAsked` applies to the
  // re-enrichment path.
  try {
    await writeCachedText(
      headword,
      MODEL_NAME,
      definition,
      generated.example.en,
      generated.example.es,
      translations,
      translationsWereAnswered(translations),
    );
  } catch (error) {
    console.error(`[api/word/text] cache write failed key=${headword}`, error);
  }

  return json(
    textResponseSchema.parse({
      definition: parsed.data.needDefinition ? definition : null,
      example: generated.example,
      translations,
    }),
    200,
  );
}
