/**
 * RL-60 (succeeds RL-53): `/api/translate` translates a sentence with the
 * model the word routes use, each call claimed against the shared daily cap
 * (`reading.model_spend`); at the cap, with no key, or when the model fails,
 * MyMemory answers as before and the answer still says `origin: "network"`.
 *
 * Drives the real `POST` with `globalThis.fetch` replaced: OpenAI and MyMemory
 * are both stubs that count their calls, any other URL throws. Nothing here
 * spends a cent. The model's reply is taken to be the Spanish sentence as
 * plain `message.content`.
 *
 * `reading.model_spend` is one global row per day, shared by every lane:
 * today's row is snapshotted and put back at the end, and no other agent may
 * spend it while this runs (docs/agentes/wordbook.md). Callers are TEST-NET addresses hashed
 * with this script's own salt; their `client_spend` rows are deleted.
 */
import Module from "node:module";

import { assertSuiteDatabase } from "@repo/harness-registry";
import postgres from "postgres";

import { clientKeyFromAddress, scopeClientKey } from "../lib/word/client-key";

assertSuiteDatabase();

const untypedModule = Module as unknown as {
  _load: (request: string, parent: unknown, isMain: boolean) => unknown;
};
const originalLoad = untypedModule._load;
untypedModule._load = (request, parent, isMain) =>
  request === "server-only" ? {} : originalLoad(request, parent, isMain);

const SALT = "check-translate-model-salt-not-a-reader";
const GLOBAL_CAP = 5;
const CLIENT_CAP = 2;
process.env.CLIENT_KEY_SALT = SALT;
process.env.OPENAI_API_KEY = "sk-check-translate-model-never-sent";
process.env.WORD_TEXT_DAILY_CALL_CAP = String(GLOBAL_CAP);
process.env.TRANSLATE_DAILY_CLIENT_CAP = String(CLIENT_CAP);

const OPENAI = "https://api.openai.com/";
const MYMEMORY = "https://api.mymemory.translated.net/";

// The critic's real case: MyMemory prepends a word the sentence never had.
const SENTENCE = "it would be there";
const MODEL_TEXT = "estaría ahí";
const MYMEMORY_TEXT = "Sin embargo, estaría ahí.";

let modelCalls = 0;
let mymemoryCalls = 0;
let modelRequests: { model?: string; messages?: { content?: string }[] }[] = [];
let modelReply: () => Response | Promise<Response> = () => modelSays(MODEL_TEXT);
let mymemoryReply: () => Response = () => mymemorySays(MYMEMORY_TEXT);

function modelSays(content: unknown): Response {
  return Response.json({ choices: [{ message: { content } }] });
}
function mymemorySays(text: string): Response {
  return Response.json({ responseData: { translatedText: text }, responseStatus: 200 });
}

globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
  const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
  if (url.startsWith(OPENAI)) {
    modelCalls += 1;
    try {
      modelRequests.push(JSON.parse(String(init?.body)));
    } catch {
      modelRequests.push({});
    }
    return modelReply();
  }
  if (url.startsWith(MYMEMORY)) {
    mymemoryCalls += 1;
    return mymemoryReply();
  }
  throw new Error(`check-translate-model: unexpected fetch to ${url}`);
}) as typeof fetch;

let failed = false;
function assert(label: string, ok: boolean, detail: string): void {
  console.log(`${ok ? "PASS" : "FAIL"}  ${label} — ${detail}`);
  if (!ok) failed = true;
}

const sql = postgres(process.env.DATABASE_URL!, { prepare: false, max: 1 });

async function spend(): Promise<number> {
  const [row] = await sql<{ calls: number }[]>`select calls from reading.model_spend where day = current_date`;
  return row?.calls ?? 0;
}
async function setSpend(calls: number): Promise<void> {
  await sql`
    insert into reading.model_spend (day, calls) values (current_date, ${calls})
    on conflict (day) do update set calls = ${calls}`;
}

let POST: (request: Request) => Promise<Response>;

// A fresh documentation-range address per call keeps each caller chargeable
// and under the per-caller cap; the route refuses the model to a caller with
// no address.
const POOL_SIZE = 40;
let nextPoolAddress = 1;
const poolAddress = (n: number): string => `203.0.113.${n}`;

async function translate(text: string, ip?: string): Promise<{ status: number; body: { text?: string; origin?: string } }> {
  const response = await POST(
    new Request("http://localhost/api/translate", {
      method: "POST",
      headers: { "content-type": "application/json", "x-forwarded-for": ip ?? poolAddress(nextPoolAddress++) },
      body: JSON.stringify({ text }),
    }),
  );
  return { status: response.status, body: (await response.json()) as { text?: string; origin?: string } };
}

function reset(): void {
  modelCalls = 0;
  mymemoryCalls = 0;
  modelRequests = [];
  modelReply = () => modelSays(MODEL_TEXT);
  mymemoryReply = () => mymemorySays(MYMEMORY_TEXT);
}

const CAP_IP = "198.51.100.41";
const capKeys = (() => {
  const unscoped = clientKeyFromAddress(CAP_IP, SALT);
  const pool = Array.from({ length: POOL_SIZE }, (_, i) => clientKeyFromAddress(poolAddress(i + 1), SALT));
  const keys = [unscoped, ...pool];
  return [...keys, ...keys.map((key) => scopeClientKey("translate", key)!), ...keys.map((key) => `share:${key}`)];
})();

async function main(): Promise<void> {
  ({ POST } = await import("../app/api/translate/route"));
  const { env } = await import("../lib/env");
  const { MODEL_NAME } = await import("../lib/word/model");
  const mutableEnv = env as { OPENAI_API_KEY?: string };

  const [prior] = await sql<{ calls: number }[]>`select calls from reading.model_spend where day = current_date`;
  try {
    await sql`delete from reading.client_spend where day = current_date and client = any(${capKeys})`;

    // 1. The model answers, once, and is counted once.
    reset();
    await setSpend(0);
    const first = await translate(SENTENCE);
    assert(
      "T1. a key and room under the cap: the model's sentence is the answer, labelled network",
      first.status === 200 && first.body.text === MODEL_TEXT && first.body.origin === "network",
      JSON.stringify(first),
    );
    assert(
      "T1. exactly one model call, no MyMemory call, one model_spend call counted",
      modelCalls === 1 && mymemoryCalls === 0 && (await spend()) === 1,
      `model=${modelCalls} mymemory=${mymemoryCalls} spend=${await spend()}`,
    );
    const request = modelRequests[0];
    assert(
      `T1. the request names the word routes' model (${MODEL_NAME}) and carries the sentence`,
      request?.model === MODEL_NAME && JSON.stringify(request).includes(SENTENCE),
      `model=${request?.model}`,
    );

    // 1b. Every call is claimed, not the first one only.
    await translate("a second sentence to translate");
    await translate("a third sentence to translate");
    assert("T1b. three model sentences count three calls", (await spend()) === 3 && modelCalls === 3, `spend=${await spend()} model=${modelCalls}`);

    // 2. At the cap: MyMemory answers, the model is never reached, the counter holds.
    reset();
    await setSpend(GLOBAL_CAP);
    const capped = await translate(SENTENCE);
    assert(
      "T2. at the daily cap MyMemory answers and the answer still says network",
      capped.status === 200 && capped.body.text === MYMEMORY_TEXT && capped.body.origin === "network",
      JSON.stringify(capped),
    );
    assert(
      "T2. at the cap the model is not called and model_spend does not move",
      modelCalls === 0 && mymemoryCalls === 1 && (await spend()) === GLOBAL_CAP,
      `model=${modelCalls} mymemory=${mymemoryCalls} spend=${await spend()}`,
    );

    // 2b. The last call under the cap is still the model's; the next is not.
    reset();
    await setSpend(GLOBAL_CAP - 1);
    const last = await translate(SENTENCE);
    const over = await translate(SENTENCE);
    assert(
      "T2b. the call that takes the cap is the model's, the one after is MyMemory's",
      last.body.text === MODEL_TEXT && over.body.text === MYMEMORY_TEXT && modelCalls === 1 && (await spend()) === GLOBAL_CAP,
      `last=${last.body.text} over=${over.body.text} model=${modelCalls} spend=${await spend()}`,
    );

    // 3. No key: MyMemory, and nothing is claimed.
    reset();
    await setSpend(1);
    mutableEnv.OPENAI_API_KEY = undefined;
    const noKey = await translate(SENTENCE);
    assert(
      "T3. with no key MyMemory answers, labelled network",
      noKey.status === 200 && noKey.body.text === MYMEMORY_TEXT && noKey.body.origin === "network",
      JSON.stringify(noKey),
    );
    assert(
      "T3. with no key the model is not called and model_spend does not move",
      modelCalls === 0 && (await spend()) === 1,
      `model=${modelCalls} spend=${await spend()}`,
    );
    mutableEnv.OPENAI_API_KEY = process.env.OPENAI_API_KEY;

    // 4. A model that fails, in each way it can, falls to MyMemory.
    const failures: [string, () => Response | Promise<Response>][] = [
      ["an HTTP 500", () => new Response(null, { status: 500 })],
      ["a network error", () => Promise.reject(new TypeError("fetch failed"))],
      ["a reply with no content", () => Response.json({ choices: [] })],
      ["an empty content", () => modelSays("")],
      ["a blank content", () => modelSays("   ")],
    ];
    for (const [name, reply] of failures) {
      reset();
      await setSpend(0);
      modelReply = reply;
      const fell = await translate(SENTENCE);
      assert(
        `T4. the model answering ${name} falls to MyMemory, labelled network`,
        fell.status === 200 && fell.body.text === MYMEMORY_TEXT && fell.body.origin === "network" && modelCalls === 1 && mymemoryCalls === 1,
        `${JSON.stringify(fell)} model=${modelCalls} mymemory=${mymemoryCalls}`,
      );
    }

    // 4b. RL-60 stays inside the fallback.
    reset();
    await setSpend(0);
    modelReply = () => new Response(null, { status: 500 });
    mymemoryReply = () =>
      Response.json({
        responseData: { translatedText: "" },
        responseStatus: 200,
        matches: [
          { translation: "", match: 0.99 },
          { translation: "El gato se sentó en la alfombra", match: 0.98 },
        ],
      });
    const candidate = await translate("the cat sat on the mat");
    assert(
      "T4b. model down and MyMemory's top pick empty: the usable candidate answers (RL-53)",
      candidate.status === 200 && candidate.body.text === "El gato se sentó en la alfombra",
      JSON.stringify(candidate),
    );

    // 4c. Both providers down: RL-59's 502, unchanged.
    reset();
    await setSpend(0);
    modelReply = () => new Response(null, { status: 500 });
    mymemoryReply = () => new Response(null, { status: 500 });
    const both = await translate(SENTENCE);
    assert("T4c. model and MyMemory both down answer 502", both.status === 502, JSON.stringify(both));

    // 6. RL-09's per-caller ceiling still applies, ahead of the model.
    reset();
    await setSpend(0);
    const statuses: number[] = [];
    for (let i = 0; i < CLIENT_CAP + 1; i += 1) statuses.push((await translate(`sentence ${i} to translate`, CAP_IP)).status);
    assert(
      `T6. the third sentence of one caller at TRANSLATE_DAILY_CLIENT_CAP=${CLIENT_CAP} answers 429`,
      statuses.join() === "200,200,429",
      `statuses=${statuses.join()}`,
    );
    // The exact split is not asserted, but the model must have served: the per-caller
    // share (#612) sends the caller's second call to MyMemory.
    assert(
      "T6. the refused sentence reached neither provider and claimed no model call",
      modelCalls >= 1 && modelCalls + mymemoryCalls === CLIENT_CAP && (await spend()) === modelCalls,
      `model=${modelCalls} mymemory=${mymemoryCalls} spend=${await spend()}`,
    );

    // 7. A model that echoes the sentence said nothing: MyMemory answers.
    for (const echo of [SENTENCE, "  It Would Be There ", "IT WOULD   BE THERE"]) {
      reset();
      await setSpend(0);
      modelReply = () => modelSays(echo);
      const echoed = await translate(SENTENCE);
      assert(
        `T7. the model echoing the sentence (${JSON.stringify(echo)}) falls to MyMemory`,
        echoed.status === 200 && echoed.body.text === MYMEMORY_TEXT && modelCalls === 1 && mymemoryCalls === 1,
        `${JSON.stringify(echoed)} model=${modelCalls} mymemory=${mymemoryCalls}`,
      );
    }

    // 8. The prompt pins translation only: a prompt that lets the model explain fails here.
    reset();
    await setSpend(0);
    await translate(SENTENCE);
    const system = (modelRequests[0]?.messages as { role?: string; content?: string }[] | undefined)?.find(
      (message) => message.role === "system",
    )?.content ?? "";
    assert(
      "T8. the system message asks for the translation only and no added words",
      /translation only/i.test(system) && /add no words/i.test(system),
      `system=${JSON.stringify(system)}`,
    );
  } finally {
    await sql`delete from reading.client_spend where day = current_date and client = any(${capKeys})`;
    if (prior) await setSpend(prior.calls);
    else await sql`delete from reading.model_spend where day = current_date`;
    await sql.end();
  }
  process.exit(failed ? 1 : 0);
}

main().catch((error: unknown) => {
  console.error(error);
  process.exit(1);
});
