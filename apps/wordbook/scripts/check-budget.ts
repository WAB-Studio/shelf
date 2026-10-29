/**
 * Drives the real spend claims (`lib/word/spend.ts`, `lib/word/client-budget.ts`)
 * and the real `POST` handlers of `/api/word/text`, `/api/word/unlisted` and
 * `/api/phrase/notes` against the local stack, with `globalThis.fetch`
 * replaced: the provider is a stub that counts its calls, and any other URL
 * throws. Nothing here spends a cent.
 *
 * Every caller is a TEST-NET address hashed with this script's own salt, so
 * none of its `reading.client_spend` rows can be a reader's. Today's
 * `reading.model_spend` row and the `reading.word_texts` rows of the
 * headwords it picks are snapshotted first and put back at the end; the
 * `reading.word_answers` rows of its invented words are deleted.
 */
import Module from "node:module";

import { assertSuiteDatabase } from "@repo/harness-registry";
import postgres from "postgres";

import { clientKeyFromAddress, scopeClientKey } from "../lib/word/client-key";

assertSuiteDatabase();

// `server-only` throws outside Next; every module below that imports it is
// loaded with `await import` in `main`, once this is in place.
const untypedModule = Module as unknown as {
  _load: (request: string, parent: unknown, isMain: boolean) => unknown;
};
const originalLoad = untypedModule._load;
untypedModule._load = (request, parent, isMain) =>
  request === "server-only" ? {} : originalLoad(request, parent, isMain);

// `lib/env.ts` parses once, at its first import: every cap is fixed here.
const SALT = "check-budget-salt-not-a-reader";
const DAILY_CAP = 1000;
const TEXT_CLIENT_CAP = 2;
const UNLISTED_CLIENT_CAP = 2;
const NOTES_DAILY_CAP = DAILY_CAP * 5;
process.env.CLIENT_KEY_SALT = SALT;
process.env.OPENAI_API_KEY = "sk-check-budget-never-sent";
process.env.WORD_TEXT_DAILY_CALL_CAP = String(DAILY_CAP);
process.env.WORD_TEXT_DAILY_CLIENT_CAP = String(TEXT_CLIENT_CAP);
process.env.WORD_UNLISTED_DAILY_CLIENT_CAP = String(UNLISTED_CLIENT_CAP);
process.env.PHRASE_NOTES_DAILY_CALL_CAP = String(NOTES_DAILY_CAP);
process.env.PHRASE_NOTES_DAILY_CLIENT_CAP = "50";

const PROVIDER = "https://api.openai.com/";

let providerCalls = 0;
let providerReply: () => Response = () => new Response(null, { status: 500 });

globalThis.fetch = (async (input: RequestInfo | URL) => {
  const url =
    typeof input === "string"
      ? input
      : input instanceof URL
        ? input.href
        : input.url;
  if (!url.startsWith(PROVIDER))
    throw new Error(`check-budget: unexpected fetch to ${url}`);
  providerCalls += 1;
  return providerReply();
}) as typeof fetch;

function modelSays(content: unknown): () => Response {
  return () =>
    Response.json({
      choices: [{ message: { content: JSON.stringify(content) } }],
    });
}

const EXAMPLE = { en: "A stub sentence.", es: "Una frase de prueba." };

const sql = postgres(process.env.DATABASE_URL!, { prepare: false, max: 1 });

let counter = 0;
let failed = false;
let passes = 0;
let failures = 0;

function assert(name: string, ok: boolean, detail: string): void {
  counter += 1;
  console.log(`${ok ? "PASS" : "FAIL"}  B${counter}. ${name} — ${detail}`);
  if (ok) passes += 1;
  else {
    failures += 1;
    failed = true;
  }
}

// Every caller this script plays, keyed both ways up front, so a run killed
// halfway is cleaned by the next one's first step.
const CALLER_IPS = [
  "198.51.100.1",
  "198.51.100.2",
  "198.51.100.3",
  "203.0.113.201",
  "203.0.113.202",
  "203.0.113.203",
  "203.0.113.204",
  "203.0.113.205",
  "203.0.113.206",
  "203.0.113.207",
  "203.0.113.208",
  "203.0.113.209",
  "203.0.113.210",
  "203.0.113.211",
  "203.0.113.212",
  "203.0.113.213",
];
const clients = new Set<string>(
  CALLER_IPS.flatMap((ip) => {
    const key = clientKeyFromAddress(ip, SALT);
    return [key, scopeClientKey("text", key)!];
  }),
);

function unscopedKey(ip: string): string {
  return clientKeyFromAddress(ip, SALT);
}

function textKey(ip: string): string {
  return scopeClientKey("text", clientKeyFromAddress(ip, SALT))!;
}

async function setDailyCalls(calls: number): Promise<void> {
  await sql`
    insert into reading.model_spend (day, calls) values (current_date, ${calls})
    on conflict (day) do update set calls = excluded.calls`;
}

async function dailyCalls(): Promise<number | null> {
  const [row] = await sql<{ calls: number }[]>`
    select calls from reading.model_spend where day = current_date`;
  return row?.calls ?? null;
}

async function clientCalls(client: string): Promise<number | null> {
  const [row] = await sql<{ calls: number }[]>`
    select calls from reading.client_spend where day = current_date and client = ${client}`;
  return row?.calls ?? null;
}

async function setClientCalls(client: string, calls: number): Promise<void> {
  await sql`
    insert into reading.client_spend (day, client, calls) values (current_date, ${client}, ${calls})
    on conflict (day, client) do update set calls = excluded.calls`;
}

function post(route: string, body: unknown, ip: string | null): Request {
  return new Request(`http://localhost${route}`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      ...(ip ? { "x-forwarded-for": ip } : {}),
    },
    body: JSON.stringify(body),
  });
}

async function main() {
  const { claimDailyCall } = await import("../lib/word/spend");
  const { claimClientCall } = await import("../lib/word/client-budget");
  const { loadDictionaryIndex } = await import("../lib/word/dictionary-index");
  const { groupFor } = await import("../lib/dictionary/index-build");
  const { isThinAnswer } = await import("../lib/word/thin");
  const { phraseHash } = await import("../lib/phrase/notes-cache");
  const text = await import("../app/api/word/text/route");
  const unlisted = await import("../app/api/word/unlisted/route");
  const notes = await import("../app/api/phrase/notes/route");

  const { env } = await import("../lib/env");
  // `env` parsed once above; a cap is switched off by writing the parsed object.
  async function withCaps<T>(
    caps: Record<string, number | undefined>,
    run: () => Promise<T>,
  ): Promise<T> {
    const live = env as unknown as Record<string, number | undefined>;
    const before = Object.fromEntries(
      Object.keys(caps).map((name) => [name, live[name]]),
    );
    Object.assign(live, caps);
    try {
      return await run();
    } finally {
      Object.assign(live, before);
    }
  }

  const index = loadDictionaryIndex();
  assert(
    "the dictionary index is parsed once per process",
    loadDictionaryIndex() === index,
    "same object twice",
  );

  // Plain lowercase headwords, so the route's own normalising leaves them as they are.
  const plain = index.sortedHeadwords.filter((headword) =>
    /^q[a-z]{5,}$/.test(headword),
  );
  const nonThin = plain
    .filter((headword) => !isThinAnswer(groupFor(index, headword)!))
    .slice(0, 10);
  const thin = plain
    .filter((headword) => isThinAnswer(groupFor(index, headword)!))
    .slice(0, 4);
  const headwords = [...nonThin, ...thin];
  console.log(`non-thin headwords: ${nonThin.join(", ")}`);
  console.log(`thin headwords: ${thin.join(", ")}`);
  if (nonThin.length < 10 || thin.length < 4)
    throw new Error(
      "check-budget: the asset no longer has the headwords it picks",
    );

  const unlistedWords = ["quorblintic", "zestrovanic", "plimvarticon"];
  const switchWord = "krondelphic";
  const notesSource = "the grey heron waited";
  const notesTranslation = "la garza gris esperaba";
  const notesHash = phraseHash(notesSource, notesTranslation);

  const [dailySnapshot] = await sql<{ calls: number }[]>`
    select calls from reading.model_spend where day = current_date`;
  const wordTextsSnapshot = await sql<{ row: unknown }[]>`
    select to_jsonb(wt) as row from reading.word_texts wt where headword = any(${headwords})`;

  async function clearFixtures(): Promise<void> {
    await sql`delete from reading.word_texts where headword = any(${headwords})`;
    await sql`delete from reading.word_answers where word = any(${[...unlistedWords, switchWord]})`;
    await sql`delete from reading.phrase_notes where phrase_hash = ${notesHash}`;
    await sql`delete from reading.client_spend where day = current_date and client = any(${[...clients]})`;
  }

  try {
    await clearFixtures();

    // --- The claims themselves -------------------------------------------
    await setDailyCalls(7);
    const refusedDaily = await claimDailyCall(7);
    const afterRefusedDaily = await dailyCalls();
    assert(
      "a daily claim at the cap is refused and does not count",
      refusedDaily === false && afterRefusedDaily === 7,
      `claim=${refusedDaily} calls=${afterRefusedDaily}`,
    );
    const admittedDaily = await claimDailyCall(8);
    const afterAdmittedDaily = await dailyCalls();
    assert(
      "a daily claim under the cap is admitted and counts once",
      admittedDaily === true && afterAdmittedDaily === 8,
      `claim=${admittedDaily} calls=${afterAdmittedDaily}`,
    );

    const probe = unscopedKey("198.51.100.1");
    await setClientCalls(probe, 3);
    const refusedClient = await claimClientCall(probe, 3);
    const afterRefusedClient = await clientCalls(probe);
    assert(
      "a client claim at the cap is refused and does not count",
      refusedClient === false && afterRefusedClient === 3,
      `claim=${refusedClient} calls=${afterRefusedClient}`,
    );
    const firstOfDay = unscopedKey("198.51.100.2");
    const firstClaim = await claimClientCall(firstOfDay, 1);
    const secondClaim = await claimClientCall(firstOfDay, 1);
    assert(
      "a caller's first claim of the day inserts at 1, and cap 1 refuses the second",
      firstClaim && !secondClaim && (await clientCalls(firstOfDay)) === 1,
      `first=${firstClaim} second=${secondClaim} calls=${await clientCalls(firstOfDay)}`,
    );

    // Concurrency: 25 claims for the last 10 calls, on the route's own pool.
    await setDailyCalls(DAILY_CAP - 10);
    const dailyRace = await Promise.all(
      Array.from({ length: 25 }, () => claimDailyCall(DAILY_CAP)),
    );
    const dailyWon = dailyRace.filter(Boolean).length;
    const afterDailyRace = await dailyCalls();
    assert(
      "25 parallel daily claims for the last 10 calls: exactly 10 win, the counter stops at the cap",
      dailyWon === 10 && afterDailyRace === DAILY_CAP,
      `won=${dailyWon} calls=${afterDailyRace}`,
    );
    const raced = unscopedKey("198.51.100.3");
    const clientRace = await Promise.all(
      Array.from({ length: 25 }, () => claimClientCall(raced, 10)),
    );
    const clientWon = clientRace.filter(Boolean).length;
    const afterClientRace = await clientCalls(raced);
    assert(
      "25 parallel first-of-day client claims at cap 10: exactly 10 win, the counter stops at 10",
      clientWon === 10 && afterClientRace === 10,
      `won=${clientWon} calls=${afterClientRace}`,
    );

    // --- /api/word/text ---------------------------------------------------
    const plainAnswer = modelSays({
      definition: null,
      example: EXAMPLE,
      translations: null,
    });

    await setDailyCalls(0);
    providerReply = plainAnswer;
    providerCalls = 0;
    const capIp = "203.0.113.201";
    const statuses: number[] = [];
    for (const headword of nonThin.slice(0, 3)) {
      const response = await text.POST(
        post("/api/word/text", { headword, needDefinition: false }, capIp),
      );
      statuses.push(response.status);
    }
    const dailyAfterCap = await dailyCalls();
    assert(
      `text: a caller's third cold lookup at WORD_TEXT_DAILY_CLIENT_CAP=${TEXT_CLIENT_CAP} answers 204 without the model`,
      statuses.join() === "200,200,204" &&
        providerCalls === 2 &&
        dailyAfterCap === 2,
      `statuses=${statuses.join()} providerCalls=${providerCalls} model_spend=${dailyAfterCap}`,
    );
    assert(
      "text: the refused lookup left the caller's counter at the cap",
      (await clientCalls(textKey(capIp))) === TEXT_CLIENT_CAP,
      `client_spend=${await clientCalls(textKey(capIp))}`,
    );
    assert(
      "text: the caller's key is scoped, so the unscoped row unlisted and notes share is untouched",
      (await clientCalls(unscopedKey(capIp))) === null,
      `unscoped client_spend=${await clientCalls(unscopedKey(capIp))}`,
    );

    // Parallel, one caller: six cold lookups at once still reach the model twice.
    providerCalls = 0;
    const raceIp = "203.0.113.202";
    const raceStatuses = await Promise.all(
      nonThin
        .slice(3, 9)
        .map((headword) =>
          text.POST(
            post("/api/word/text", { headword, needDefinition: false }, raceIp),
          ),
        ),
    );
    const raceOk = raceStatuses.filter(
      (response) => response.status === 200,
    ).length;
    assert(
      "text: six parallel cold lookups from one caller reach the model exactly twice",
      raceOk === TEXT_CLIENT_CAP && providerCalls === TEXT_CLIENT_CAP,
      `200s=${raceOk} providerCalls=${providerCalls}`,
    );

    providerCalls = 0;
    const dailyBeforeNoKey = await dailyCalls();
    const noKey = await text.POST(
      post(
        "/api/word/text",
        { headword: nonThin[9], needDefinition: false },
        null,
      ),
    );
    const [{ count: noKeyRows }] = await sql<{ count: number }[]>`
      select count(*)::int as count from reading.word_texts where headword = ${nonThin[9]}`;
    assert(
      "text: a caller with no address to key answers 204, no model call, no row, no spend",
      noKey.status === 204 &&
        providerCalls === 0 &&
        noKeyRows === 0 &&
        (await dailyCalls()) === dailyBeforeNoKey,
      `status=${noKey.status} providerCalls=${providerCalls} rows=${noKeyRows}`,
    );

    // Thin, answered empty: closed for good.
    providerReply = modelSays({
      definition: null,
      example: EXAMPLE,
      translations: [],
    });
    providerCalls = 0;
    const emptyIp = "203.0.113.203";
    const emptyFirst = await text.POST(
      post(
        "/api/word/text",
        { headword: thin[0], needDefinition: false },
        emptyIp,
      ),
    );
    const [emptyRow] = await sql<
      { translations: string[] | null; translations_asked: boolean }[]
    >`
      select translations, translations_asked from reading.word_texts where headword = ${thin[0]}`;
    assert(
      "text: a thin word the model answers with [] is written closed",
      emptyFirst.status === 200 &&
        providerCalls === 1 &&
        emptyRow?.translations_asked === true &&
        emptyRow.translations?.length === 0,
      `status=${emptyFirst.status} providerCalls=${providerCalls} row=${JSON.stringify(emptyRow)}`,
    );
    providerCalls = 0;
    const emptySecond = await text.POST(
      post(
        "/api/word/text",
        { headword: thin[0], needDefinition: false },
        emptyIp,
      ),
    );
    assert(
      "text: the second lookup of that word never reaches the model",
      emptySecond.status === 200 && providerCalls === 0,
      `status=${emptySecond.status} providerCalls=${providerCalls}`,
    );

    // Thin, a row whose ask never closed, and a provider that fails: still open.
    await sql`
      insert into reading.word_texts (headword, definition, example_en, example_es, model, translations, translations_asked)
      values (${thin[1]}, null, ${EXAMPLE.en}, ${EXAMPLE.es}, 'check-budget', null, false)`;
    providerReply = () => new Response(null, { status: 500 });
    providerCalls = 0;
    const failIp = "203.0.113.204";
    const failFirst = await text.POST(
      post(
        "/api/word/text",
        { headword: thin[1], needDefinition: false },
        failIp,
      ),
    );
    const [failRow] = await sql<{ translations_asked: boolean }[]>`
      select translations_asked from reading.word_texts where headword = ${thin[1]}`;
    assert(
      "text: a failed enrichment answers the cached row and leaves the ask open",
      failFirst.status === 200 &&
        providerCalls === 1 &&
        failRow?.translations_asked === false,
      `status=${failFirst.status} providerCalls=${providerCalls} row=${JSON.stringify(failRow)}`,
    );
    providerCalls = 0;
    await text.POST(
      post(
        "/api/word/text",
        { headword: thin[1], needDefinition: false },
        failIp,
      ),
    );
    assert(
      "text: the next lookup of that word asks again",
      providerCalls === 1,
      `providerCalls=${providerCalls}`,
    );

    // Thin, cold, a model that answers but leaves translations null: open too.
    providerReply = plainAnswer;
    providerCalls = 0;
    const nullCold = await text.POST(
      post(
        "/api/word/text",
        { headword: thin[2], needDefinition: false },
        "203.0.113.205",
      ),
    );
    const [nullRow] = await sql<{ translations_asked: boolean }[]>`
      select translations_asked from reading.word_texts where headword = ${thin[2]}`;
    assert(
      "text: a thin word whose cold answer carries no translations is written open",
      nullCold.status === 200 &&
        providerCalls === 1 &&
        nullRow?.translations_asked === false,
      `status=${nullCold.status} providerCalls=${providerCalls} row=${JSON.stringify(nullRow)}`,
    );

    // Thin, cached and still open: the backfill claims the caller's cap too.
    await sql`
      insert into reading.word_texts (headword, definition, example_en, example_es, model, translations, translations_asked)
      values (${thin[3]}, null, ${EXAMPLE.en}, ${EXAMPLE.es}, 'check-budget', null, false)`;
    providerReply = modelSays({
      definition: null,
      example: EXAMPLE,
      translations: ["prueba"],
    });
    const backfillIp = "203.0.113.208";
    await setClientCalls(textKey(backfillIp), TEXT_CLIENT_CAP);
    const dailyBeforeBackfill = await dailyCalls();
    providerCalls = 0;
    const backfillAtCap = await text.POST(
      post(
        "/api/word/text",
        { headword: thin[3], needDefinition: false },
        backfillIp,
      ),
    );
    const [backfillRow] = await sql<{ translations_asked: boolean }[]>`
      select translations_asked from reading.word_texts where headword = ${thin[3]}`;
    assert(
      "text: a backfill from a caller at WORD_TEXT_DAILY_CLIENT_CAP answers the cached row without the model",
      backfillAtCap.status === 200 &&
        providerCalls === 0 &&
        (await dailyCalls()) === dailyBeforeBackfill &&
        (await clientCalls(textKey(backfillIp))) === TEXT_CLIENT_CAP &&
        backfillRow?.translations_asked === false,
      `status=${backfillAtCap.status} providerCalls=${providerCalls} model_spend=${await dailyCalls()} ` +
        `(was ${dailyBeforeBackfill}) row=${JSON.stringify(backfillRow)}`,
    );
    providerCalls = 0;
    const backfillNoKey = await text.POST(
      post(
        "/api/word/text",
        { headword: thin[3], needDefinition: false },
        null,
      ),
    );
    assert(
      "text: a backfill from a caller with no address to key never reaches the model",
      backfillNoKey.status === 200 &&
        providerCalls === 0 &&
        (await dailyCalls()) === dailyBeforeBackfill,
      `status=${backfillNoKey.status} providerCalls=${providerCalls} model_spend=${await dailyCalls()}`,
    );

    // --- /api/phrase/notes ------------------------------------------------
    // The model's reply never validates, so no notes row is ever written.
    providerReply = modelSays({ nothing: true });
    await setDailyCalls(DAILY_CAP);
    providerCalls = 0;
    const notesIp = "203.0.113.206";
    const notesBody = { source: notesSource, translation: notesTranslation };
    const notesAtGlobal = await notes.POST(
      post("/api/phrase/notes", notesBody, notesIp),
    );
    assert(
      `notes: the day at WORD_TEXT_DAILY_CALL_CAP answers 204 though PHRASE_NOTES_DAILY_CALL_CAP=${NOTES_DAILY_CAP}`,
      notesAtGlobal.status === 204 && providerCalls === 0,
      `status=${notesAtGlobal.status} providerCalls=${providerCalls}`,
    );
    assert(
      "notes: the refused request left model_spend where it was",
      (await dailyCalls()) === DAILY_CAP,
      `model_spend=${await dailyCalls()}`,
    );
    await setDailyCalls(DAILY_CAP - 1);
    const notesUnderGlobal = await notes.POST(
      post("/api/phrase/notes", notesBody, notesIp),
    );
    assert(
      "notes: one call under the global cap, the same request reaches the model",
      providerCalls === 1 && (await dailyCalls()) === DAILY_CAP,
      `status=${notesUnderGlobal.status} providerCalls=${providerCalls} model_spend=${await dailyCalls()}`,
    );

    // --- /api/word/unlisted -----------------------------------------------
    await setDailyCalls(0);
    providerReply = modelSays({
      translations: ["prueba"],
      definition: "A stub definition.",
      example: EXAMPLE,
    });
    providerCalls = 0;
    const unlistedIp = "203.0.113.207";
    const unlistedStatuses: number[] = [];
    for (const word of unlistedWords) {
      const response = await unlisted.POST(
        post("/api/word/unlisted", { word }, unlistedIp),
      );
      unlistedStatuses.push(response.status);
    }
    assert(
      `unlisted: under WORD_UNLISTED_DAILY_CLIENT_CAP=${UNLISTED_CLIENT_CAP} answers 200, over it 204`,
      unlistedStatuses.join() === "200,200,204" &&
        providerCalls === UNLISTED_CLIENT_CAP,
      `statuses=${unlistedStatuses.join()} providerCalls=${providerCalls}`,
    );
    assert(
      "unlisted: the refused request left the caller's shared counter at the cap",
      (await clientCalls(unscopedKey(unlistedIp))) === UNLISTED_CLIENT_CAP,
      `client_spend=${await clientCalls(unscopedKey(unlistedIp))}`,
    );

    // --- Each cap switch, alone -------------------------------------------
    const switchBody = { source: notesSource, translation: notesTranslation };
    providerReply = modelSays({ nothing: true });

    // unlisted: the day at the global cap, the caller well under its own.
    await setDailyCalls(DAILY_CAP);
    providerCalls = 0;
    const unlistedDayFull = await unlisted.POST(
      post("/api/word/unlisted", { word: switchWord }, "203.0.113.209"),
    );
    assert(
      "unlisted: the day at WORD_TEXT_DAILY_CALL_CAP answers 204 without the model",
      unlistedDayFull.status === 204 &&
        providerCalls === 0 &&
        (await dailyCalls()) === DAILY_CAP,
      `status=${unlistedDayFull.status} providerCalls=${providerCalls} model_spend=${await dailyCalls()}`,
    );

    await setDailyCalls(0);
    providerCalls = 0;
    const unlistedNoGlobal = await withCaps(
      { WORD_TEXT_DAILY_CALL_CAP: undefined },
      () =>
        unlisted
          .POST(
            post("/api/word/unlisted", { word: switchWord }, "203.0.113.209"),
          )
          .catch(() => null),
    );
    assert(
      "unlisted: WORD_TEXT_DAILY_CALL_CAP unset answers 204 without the model",
      unlistedNoGlobal?.status === 204 &&
        providerCalls === 0 &&
        (await dailyCalls()) === 0,
      `status=${unlistedNoGlobal?.status} providerCalls=${providerCalls} model_spend=${await dailyCalls()}`,
    );

    // notes: a per-caller ceiling of 2, the third call from one caller.
    await setDailyCalls(0);
    providerCalls = 0;
    const notesClientIp = "203.0.113.210";
    const notesClientStatuses: number[] = [];
    await withCaps({ PHRASE_NOTES_DAILY_CLIENT_CAP: 2 }, async () => {
      for (let i = 0; i < 3; i += 1) {
        const response = await notes.POST(
          post("/api/phrase/notes", switchBody, notesClientIp),
        );
        notesClientStatuses.push(response.status);
      }
    });
    assert(
      "notes: a caller's third call at PHRASE_NOTES_DAILY_CLIENT_CAP=2 answers 204 without the model",
      providerCalls === 2 &&
        notesClientStatuses[2] === 204 &&
        (await clientCalls(unscopedKey(notesClientIp))) === 2 &&
        (await dailyCalls()) === 2,
      `statuses=${notesClientStatuses.join()} providerCalls=${providerCalls} ` +
        `client_spend=${await clientCalls(unscopedKey(notesClientIp))} model_spend=${await dailyCalls()}`,
    );

    // notes: each global cap unset, a fresh caller each time.
    await setDailyCalls(0);
    providerCalls = 0;
    const notesNoOwn = await withCaps(
      { PHRASE_NOTES_DAILY_CALL_CAP: undefined },
      () =>
        notes
          .POST(post("/api/phrase/notes", switchBody, "203.0.113.211"))
          .catch(() => null),
    );
    assert(
      "notes: PHRASE_NOTES_DAILY_CALL_CAP unset answers 204 without the model",
      notesNoOwn?.status === 204 &&
        providerCalls === 0 &&
        (await dailyCalls()) === 0,
      `status=${notesNoOwn?.status} providerCalls=${providerCalls} model_spend=${await dailyCalls()}`,
    );
    const notesNoShared = await withCaps(
      { WORD_TEXT_DAILY_CALL_CAP: undefined },
      () =>
        notes
          .POST(post("/api/phrase/notes", switchBody, "203.0.113.212"))
          .catch(() => null),
    );
    assert(
      "notes: WORD_TEXT_DAILY_CALL_CAP unset answers 204 without the model",
      notesNoShared?.status === 204 &&
        providerCalls === 0 &&
        (await dailyCalls()) === 0,
      `status=${notesNoShared?.status} providerCalls=${providerCalls} model_spend=${await dailyCalls()}`,
    );

    // text: key set, WORD_TEXT_DAILY_CALL_CAP unset, a cold headword.
    providerReply = plainAnswer;
    providerCalls = 0;
    const textNoCap = await withCaps(
      { WORD_TEXT_DAILY_CALL_CAP: undefined },
      () =>
        text
          .POST(
            post(
              "/api/word/text",
              { headword: nonThin[9], needDefinition: false },
              "203.0.113.213",
            ),
          )
          .catch(() => null),
    );
    const [{ count: textNoCapRows }] = await sql<{ count: number }[]>`
      select count(*)::int as count from reading.word_texts where headword = ${nonThin[9]}`;
    assert(
      "text: WORD_TEXT_DAILY_CALL_CAP unset answers 204 without the model and writes no row",
      textNoCap?.status === 204 &&
        providerCalls === 0 &&
        textNoCapRows === 0 &&
        (await dailyCalls()) === 0,
      `status=${textNoCap?.status} providerCalls=${providerCalls} rows=${textNoCapRows} model_spend=${await dailyCalls()}`,
    );
  } finally {
    await clearFixtures();
    for (const { row } of wordTextsSnapshot) {
      await sql`insert into reading.word_texts select * from jsonb_populate_record(null::reading.word_texts, ${sql.json(row as postgres.JSONValue)})`;
    }
    if (dailySnapshot) await setDailyCalls(dailySnapshot.calls);
    else await sql`delete from reading.model_spend where day = current_date`;
    console.log(
      `Cleanup: ${clients.size} client keys, ${headwords.length} headwords (${wordTextsSnapshot.length} restored), ` +
        `model_spend ${dailySnapshot ? `restored to ${dailySnapshot.calls}` : "row removed"}`,
    );
  }

  await sql.end();
  console.log("");
  console.log(`REPORT  ${passes} pass, ${failures} fail`);
  process.exit(failed ? 1 : 0);
}

main().catch((error: unknown) => {
  console.error(error);
  process.exit(1);
});
