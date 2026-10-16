/**
 * Drives the real `POST` of `/api/word/unlisted` against the local stack with
 * `globalThis.fetch` replaced: the provider is a stub that counts its calls
 * and any other URL throws. Nothing here spends a cent, and nothing starts a
 * `next dev` — the pattern `check-budget.ts` uses.
 *
 * Baseline cause of the old script's 204s (D3, D4, D6, D10): `.env.local`
 * sets no `WORD_UNLISTED_DAILY_CLIENT_CAP` and no `CLIENT_KEY_SALT`, so the
 * route's absence gate answered 204 before any model call — the environment,
 * not the route. The caps this script needs are fixed here, before `lib/env`
 * parses; phase 2 unsets the cap on the parsed `env` object itself.
 *
 * Every caller is a TEST-NET address hashed with this script's own salt.
 * Today's `reading.model_spend` row is snapshotted and put back at the end;
 * the `reading.word_answers` rows of its invented words are deleted.
 */
import Module from "node:module";
import { readFileSync } from "node:fs";
import path from "node:path";
import { dirname } from "node:path";
import { fileURLToPath } from "node:url";

import { assertSuiteDatabase } from "@repo/harness-registry";
import postgres from "postgres";

import { admitWord } from "../lib/word/admit";
import { clientKeyFromAddress } from "../lib/word/client-key";
import type { DictionaryPayload } from "../lib/dictionary/format";
import { buildIndex } from "../lib/dictionary/index-build";
import { lookupWord } from "../lib/dictionary/lookup";

assertSuiteDatabase();

// `server-only` throws outside Next; the route is loaded with `await import`
// in `main`, once this is in place.
const untypedModule = Module as unknown as {
  _load: (request: string, parent: unknown, isMain: boolean) => unknown;
};
const originalLoad = untypedModule._load;
untypedModule._load = (request, parent, isMain) =>
  request === "server-only" ? {} : originalLoad(request, parent, isMain);

const SALT = "check-unlisted-salt-not-a-reader";
const ORDINARY_CAP = 50;
process.env.CLIENT_KEY_SALT = SALT;
process.env.OPENAI_API_KEY = "sk-check-unlisted-never-sent";
process.env.WORD_TEXT_DAILY_CALL_CAP = "1000";
process.env.WORD_UNLISTED_DAILY_CLIENT_CAP = String(ORDINARY_CAP);

const APP_DIR = dirname(dirname(fileURLToPath(import.meta.url)));
const PROVIDER = "https://api.openai.com/";

let providerCalls = 0;
let providerReply: () => Response = () => new Response(null, { status: 500 });

globalThis.fetch = (async (input: RequestInfo | URL) => {
  const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
  if (!url.startsWith(PROVIDER)) throw new Error(`check-unlisted: unexpected fetch to ${url}`);
  providerCalls += 1;
  return providerReply();
}) as typeof fetch;

function modelSays(content: unknown): () => Response {
  return () => Response.json({ choices: [{ message: { content: JSON.stringify(content) } }] });
}

const STUB_ANSWER = {
  translations: ["prueba"],
  definition: "A stub definition.",
  example: { en: "A stub sentence.", es: "Una frase de prueba." },
};

// Real dictionary/admission shapes. `coccidiosis` has no entry and no
// inflection of one; `swishing` is `swish` + `-ing`; `snuff` is a real
// headword — this route's turf is what the dictionary has nothing on.
const UNLISTED_WORD = "coccidiosis";
const INFLECTED_WORD = "swishing";
const INFLECTED_LEMMA = "swish";
const INFLECTED_RULE = "ing";
const LISTED_WORD = "snuff";
const SENTENCE = "hello world";
const CAP_UNSET_WORD = "quorlisking";
const CAP_ONE_WORD = "vandrossity";

const MAIN_CALLER_IP = "203.0.113.50";
const CAP_UNSET_CALLER_IP = "203.0.113.66";
const CAP_ONE_CALLER_IP = "203.0.113.77";

let counter = 0;
let failed = false;
let passes = 0;
let failures = 0;

function next(name: string): string {
  counter += 1;
  return `D${counter}. ${name}`;
}

function assert(label: string, ok: boolean, detail: string): void {
  console.log(`${ok ? "PASS" : "FAIL"}  ${label} — ${detail}`);
  if (ok) passes += 1;
  else {
    failures += 1;
    failed = true;
  }
}

function clientKey(address: string): string {
  return clientKeyFromAddress(address, SALT);
}

function post(word: string, ip: string): Request {
  return new Request("http://localhost/api/word/unlisted", {
    method: "POST",
    headers: { "content-type": "application/json", "x-forwarded-for": ip },
    body: JSON.stringify({ word }),
  });
}

async function main() {
  const sql = postgres(process.env.DATABASE_URL!, { prepare: false, max: 1 });
  const { POST } = await import("../app/api/word/unlisted/route");
  const { env } = await import("../lib/env");

  async function request(word: string, ip: string): Promise<{ status: number; body: unknown }> {
    const response = await POST(post(word, ip));
    return { status: response.status, body: response.status === 200 ? await response.json() : null };
  }

  type WordAnswerRow = { word: string };
  async function wordAnswerRow(word: string): Promise<WordAnswerRow | undefined> {
    const [row] = await sql<WordAnswerRow[]>`select word from reading.word_answers where word = ${word}`;
    return row;
  }
  async function deleteWordAnswer(word: string): Promise<number> {
    const result = await sql`delete from reading.word_answers where word = ${word}`;
    return result.count;
  }
  async function deleteClientSpend(client: string): Promise<number> {
    const result = await sql`delete from reading.client_spend where day = current_date and client = ${client}`;
    return result.count;
  }
  async function setDailyCalls(calls: number): Promise<void> {
    await sql`
      insert into reading.model_spend (day, calls) values (current_date, ${calls})
      on conflict (day) do update set calls = excluded.calls`;
  }
  async function readModelSpendCalls(): Promise<number> {
    const [row] = await sql<{ calls: number }[]>`select calls from reading.model_spend where day = current_date`;
    return row?.calls ?? 0;
  }

  const words = [UNLISTED_WORD, INFLECTED_WORD, CAP_UNSET_WORD, CAP_ONE_WORD];
  const clients = [MAIN_CALLER_IP, CAP_UNSET_CALLER_IP, CAP_ONE_CALLER_IP].map(clientKey);
  async function clearFixtures(): Promise<number> {
    let deleted = 0;
    for (const word of words) deleted += await deleteWordAnswer(word);
    for (const client of clients) await deleteClientSpend(client);
    return deleted;
  }

  const [dailySnapshot] = await sql<{ calls: number }[]>`
    select calls from reading.model_spend where day = current_date`;
  const mutableEnv = env as { WORD_UNLISTED_DAILY_CLIENT_CAP?: number };

  try {
    const leftover = await clearFixtures();
    if (leftover > 0) console.log(`Cleared ${leftover} leftover row(s) from an earlier run before starting.`);
    await setDailyCalls(0);
    providerReply = modelSays(STUB_ANSWER);

    const assetPayload = JSON.parse(
      readFileSync(path.join(APP_DIR, "public", "dictionary", "eng-spa-2025.11.23.json"), "utf8"),
    ) as DictionaryPayload;
    const index = buildIndex(assetPayload);
    const unlistedLookup = lookupWord(index, admitWord(UNLISTED_WORD) ?? UNLISTED_WORD);
    assert(
      next(`"${UNLISTED_WORD}" carries no exact entry and no inflection`),
      unlistedLookup.exact === null && unlistedLookup.viaInflection.length === 0,
      `exact=${Boolean(unlistedLookup.exact)}, viaInflection=${unlistedLookup.viaInflection.length}`,
    );
    const inflectedLookup = lookupWord(index, admitWord(INFLECTED_WORD) ?? INFLECTED_WORD);
    assert(
      next(`"${INFLECTED_WORD}" traces to "${INFLECTED_LEMMA}" via "${INFLECTED_RULE}"`),
      inflectedLookup.viaInflection[0]?.lemma === INFLECTED_LEMMA &&
        inflectedLookup.viaInflection[0]?.rule === INFLECTED_RULE,
      `viaInflection[0]=${JSON.stringify(inflectedLookup.viaInflection[0])}`,
    );

    // Phase 1 — the ordinary config: D3 through D8.
    providerCalls = 0;
    const first = await request(UNLISTED_WORD, MAIN_CALLER_IP);
    const firstParsed = first.body as {
      translations?: string[];
      definition?: string | null;
      example?: { en?: string; es?: string };
    } | null;
    assert(
      next(`"${UNLISTED_WORD}" answers 200 with a translation, a definition and a two-sided example`),
      first.status === 200 &&
        Array.isArray(firstParsed?.translations) &&
        firstParsed.translations.length >= 1 &&
        firstParsed.translations.every((t) => t.length > 0) &&
        typeof firstParsed?.definition === "string" &&
        firstParsed.definition.length > 0 &&
        typeof firstParsed?.example?.en === "string" &&
        firstParsed.example.en.length > 0 &&
        typeof firstParsed?.example?.es === "string" &&
        firstParsed.example.es.length > 0 &&
        providerCalls === 1 &&
        Boolean(await wordAnswerRow(UNLISTED_WORD)),
      `status=${first.status}, providerCalls=${providerCalls}, body=${JSON.stringify(firstParsed)}`,
    );

    const callsBefore = await readModelSpendCalls();
    const providerBefore = providerCalls;
    const second = await request(UNLISTED_WORD, MAIN_CALLER_IP);
    const callsAfter = await readModelSpendCalls();
    assert(
      next(`the second identical request for "${UNLISTED_WORD}" answers the same body without calling the provider`),
      second.status === 200 &&
        JSON.stringify(second.body) === JSON.stringify(first.body) &&
        providerCalls === providerBefore,
      `status=${second.status}, same body=${JSON.stringify(second.body) === JSON.stringify(first.body)}, providerCalls=${providerCalls - providerBefore} more`,
    );
    assert(
      next("reading.model_spend.calls reads the same number before and after the cache hit"),
      callsBefore === callsAfter,
      `before=${callsBefore}, after=${callsAfter}`,
    );

    const inflected = await request(INFLECTED_WORD, MAIN_CALLER_IP);
    const inflectedBody = inflected.body as { translations?: string[]; lemma?: string | null; rule?: string | null } | null;
    assert(
      next(`"${INFLECTED_WORD}" answers with lemma "${INFLECTED_LEMMA}", rule "${INFLECTED_RULE}"`),
      inflected.status === 200 &&
        inflectedBody?.lemma === INFLECTED_LEMMA &&
        inflectedBody?.rule === INFLECTED_RULE &&
        Array.isArray(inflectedBody?.translations) &&
        inflectedBody.translations.length >= 1,
      `status=${inflected.status}, body=${JSON.stringify(inflectedBody)}`,
    );

    const providerBeforeRefused = providerCalls;
    const listed = await request(LISTED_WORD, MAIN_CALLER_IP);
    assert(next(`"${LISTED_WORD}" (the dictionary has it) answers 400`), listed.status === 400, `status=${listed.status}`);
    const sentence = await request(SENTENCE, MAIN_CALLER_IP);
    assert(
      next(`"${SENTENCE}" (not one word) answers 400`),
      sentence.status === 400 && providerCalls === providerBeforeRefused,
      `status=${sentence.status}`,
    );

    // Phase 2 — the cap unset: a cold word answers 204 and writes no row.
    mutableEnv.WORD_UNLISTED_DAILY_CLIENT_CAP = undefined;
    const providerBeforeUnset = providerCalls;
    const unset = await request(CAP_UNSET_WORD, CAP_UNSET_CALLER_IP);
    const unsetRow = await wordAnswerRow(CAP_UNSET_WORD);
    assert(
      next(`with no WORD_UNLISTED_DAILY_CLIENT_CAP, "${CAP_UNSET_WORD}" answers 204 and writes no row`),
      unset.status === 204 && !unsetRow && providerCalls === providerBeforeUnset,
      `status=${unset.status}, row written=${Boolean(unsetRow)}`,
    );

    // Phase 3 — the per-caller cap pinned at 1.
    mutableEnv.WORD_UNLISTED_DAILY_CLIENT_CAP = 1;
    const firstCold = await request(CAP_ONE_WORD, CAP_ONE_CALLER_IP);
    assert(
      next(`with the per-caller cap at 1, the caller's first cold word "${CAP_ONE_WORD}" answers 200`),
      firstCold.status === 200,
      `status=${firstCold.status}`,
    );
    const providerBeforeSecond = providerCalls;
    const secondCold = await request(CAP_UNSET_WORD, CAP_ONE_CALLER_IP);
    const secondColdRow = await wordAnswerRow(CAP_UNSET_WORD);
    assert(
      next(`with the per-caller cap at 1, the same caller's second cold word "${CAP_UNSET_WORD}" answers 204 the same day`),
      secondCold.status === 204 && !secondColdRow && providerCalls === providerBeforeSecond,
      `status=${secondCold.status}, row written=${Boolean(secondColdRow)}, providerCalls=${providerCalls - providerBeforeSecond} more`,
    );
  } finally {
    const rowsDeleted = await clearFixtures();
    if (dailySnapshot) await setDailyCalls(dailySnapshot.calls);
    else await sql`delete from reading.model_spend where day = current_date`;
    console.log(`Cleanup: deleted ${rowsDeleted} reading.word_answers row(s) and the callers' client_spend rows this run wrote.`);
  }

  assert(
    next("this run leaves reading.word_answers with none of its own fixture rows"),
    !(await wordAnswerRow(UNLISTED_WORD)) &&
      !(await wordAnswerRow(INFLECTED_WORD)) &&
      !(await wordAnswerRow(CAP_ONE_WORD)) &&
      !(await wordAnswerRow(CAP_UNSET_WORD)),
    "checked after cleanup",
  );

  await sql.end();

  console.log("");
  console.log(`REPORT  ${passes} pass, ${failures} fail`);
  process.exit(failed ? 1 : 0);
}

main().catch((error: unknown) => {
  console.error(error);
  process.exit(1);
});
