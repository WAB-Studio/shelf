import "server-only";

import { normaliseHeadword } from "@/lib/dictionary/format";
import { groupFor } from "@/lib/dictionary/index-build";
import { env } from "@/lib/env";
import { claimClientCall, scopedClientKey } from "@/lib/word/client-budget";
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
import { inflectionReallyMovedReader, isInflectionDisagreement, isThinAnswer } from "@/lib/word/thin";

// RL-41 and RL-42's decoration: no reader session reaches this route, the
// cache is keyed on the headword alone (`db/schema/word-texts.ts`), and its
// answer is never a candidate for the full route cache.
export const dynamic = "force-dynamic";

// Above the provider's own 20 s timeout, so a slow model answers 204 rather
// than the platform killing the function mid-claim.
export const maxDuration = 30;

const NO_STORE = { "Cache-Control": "no-store" };

function json(body: unknown, status: number): Response {
  return Response.json(body, { status, headers: NO_STORE });
}

function empty(status: 204 | 400): Response {
  return new Response(null, { status, headers: NO_STORE });
}

// The caller's cap, then the day's, in series: run in parallel, a caller
// already refused would still take one of the day's calls. No chargeable
// caller (no salt, no address) reaches the model at all.
async function claimModelCall(request: Request, dailyCap: number): Promise<boolean> {
  try {
    const client = scopedClientKey("text", request.headers);
    if (!client) return false;
    if (!(await claimClientCall(client, env.WORD_TEXT_DAILY_CLIENT_CAP))) return false;
    return await claimDailyCall(dailyCap);
  } catch (error) {
    console.error("[api/word/text] claim failed", error);
    return false;
  }
}

export async function POST(request: Request): Promise<Response> {
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

  // RL-45's own decision, over this route's own group and its own re-check
  // of the client's `surface`/`rule` pair — the client sends a claim, never
  // a flag, and a claim that does not hold up is treated as a plain lookup.
  const { surface, rule } = parsed.data;
  const disagrees =
    surface !== undefined &&
    rule !== undefined &&
    inflectionReallyMovedReader(index, headword, surface, rule) &&
    isInflectionDisagreement(group, rule);
  const thin = isThinAnswer(group) || disagrees;

  let cached: Awaited<ReturnType<typeof readCachedText>>;
  try {
    cached = await readCachedText(headword);
  } catch (error) {
    console.error("[api/word/text] cache read failed", error);
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
    if (
      thin &&
      !cached.translationsAsked &&
      env.OPENAI_API_KEY &&
      env.WORD_TEXT_DAILY_CALL_CAP &&
      (await claimModelCall(request, env.WORD_TEXT_DAILY_CALL_CAP))
    ) {
      const generated = await generateWordText(headword, false, group.senses);
      translations = generated?.translations ?? null;
      await markTranslationsAsked(headword, translations);
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
  // over the cap, a provider failure, or a generation that fails to
  // validate, or no chargeable caller all answer `204`, the same "no connection" screen already
  // drawn (RL-35).
  if (!env.OPENAI_API_KEY || !env.WORD_TEXT_DAILY_CALL_CAP) {
    return empty(204);
  }

  if (!(await claimModelCall(request, env.WORD_TEXT_DAILY_CALL_CAP))) {
    return empty(204);
  }

  // RL-41 fires only when every sense the group carries is definition-less:
  // one dictionary definition anywhere in the group is "already has one",
  // whatever the caller's own `needDefinition` claims.
  const entryLacksDefinition = group.senses.every((sense) => sense.definition === null);
  const wantDefinition = parsed.data.needDefinition && entryLacksDefinition;

  // RL-45 rides this same call when the entry is thin — no second call, so
  // no second daily-cap claim for the one lookup.
  const generated = await generateWordText(headword, wantDefinition, thin ? group.senses : null);
  if (!generated) {
    return empty(204);
  }

  const definition = wantDefinition ? generated.definition : null;
  const translations = thin ? generated.translations : null;
  // A thin word the model answered, even with `[]`, is closed; one it left
  // null stays open — the same rule `markTranslationsAsked` applies to the
  // re-enrichment path.
  await writeCachedText(
    headword,
    MODEL_NAME,
    definition,
    generated.example.en,
    generated.example.es,
    translations,
    translationsWereAnswered(translations),
  );

  return json(
    textResponseSchema.parse({
      definition: parsed.data.needDefinition ? definition : null,
      example: generated.example,
      translations,
    }),
    200,
  );
}
