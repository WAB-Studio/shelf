/**
 * Drives `app/api/translate/route.ts`'s `POST` handler directly, with
 * `global.fetch` stubbed to answer as MyMemory does — never the real
 * endpoint, whose anonymous quota is shared and capped.
 *
 * Proves the one branch the route did not have: a reply identical to the
 * request, once folded, is refused exactly like an empty `translatedText`
 * or a quota warning already were. Every prior branch is re-run too, so
 * this file stands as the route's only regression cover, not only the new
 * line's.
 *
 * Also proves RL-60: an empty `translatedText` alongside a usable `matches`
 * entry is answered from that entry, not refused. The stub for that case is
 * the real reply measured with `curl` against `api.mymemory.translated.net`
 * for "the cat sat on the mat", trimmed to the fields this route reads.
 *
 * Last, the per-caller cap (`TRANSLATE_DAILY_CLIENT_CAP`, set to 2 here) and
 * the provider's deadline: those write `reading.client_spend` under keys
 * hashed with this script's own salt, so they run on the local stack only,
 * and delete their rows on the way out.
 */
import Module from "node:module";

import { assertSuiteDatabase } from "@repo/harness-registry";
import postgres from "postgres";

import { clientKeyFromAddress, scopeClientKey } from "../lib/word/client-key";

assertSuiteDatabase();

// `server-only` throws outside Next; the route is loaded with `await import`
// in `main`, once this is in place.
const untypedModule = Module as unknown as {
  _load: (request: string, parent: unknown, isMain: boolean) => unknown;
};
const originalLoad = untypedModule._load;
untypedModule._load = (request, parent, isMain) =>
  request === "server-only" ? {} : originalLoad(request, parent, isMain);

// `lib/env.ts` parses once, at its first import.
const SALT = "check-translate-salt-not-a-reader";
const CLIENT_CAP = 2;
process.env.CLIENT_KEY_SALT = SALT;
process.env.TRANSLATE_DAILY_CLIENT_CAP = String(CLIENT_CAP);
// RL-60: with no key the route never reaches the paid model, only MyMemory.
delete process.env.OPENAI_API_KEY;

let POST: (request: Request) => Promise<Response>;

let failed = false;

function assert(label: string, ok: boolean, detail: string): void {
  console.log(`${ok ? "PASS" : "FAIL"}  ${label} — ${detail}`);
  if (!ok) failed = true;
}

type MyMemoryMatchStub = { translation?: string; quality?: string; match?: number };

type MyMemoryStub = {
  responseData?: { translatedText?: string };
  responseStatus?: number | string;
  matches?: MyMemoryMatchStub[];
};

function stubFetch(payload: MyMemoryStub, ok = true): void {
  globalThis.fetch = (async () =>
    new Response(JSON.stringify(payload), { status: ok ? 200 : 500 })) as typeof fetch;
}

async function postTranslate(text: string, ip?: string): Promise<{ status: number; body: unknown }> {
  const request = new Request("http://localhost/api/translate", {
    method: "POST",
    headers: { "Content-Type": "application/json", ...(ip ? { "x-forwarded-for": ip } : {}) },
    body: JSON.stringify({ text }),
  });
  const response = await POST(request);
  return { status: response.status, body: await response.json() };
}

async function main() {
  ({ POST } = await import("../app/api/translate/route"));

  // A genuine translation still passes: the fold never touches two strings
  // that actually differ.
  stubFetch({ responseData: { translatedText: "Me fui de mi casa ayer" }, responseStatus: 200 });
  const genuine = await postTranslate("I left my house yesterday");
  assert(
    "a real translation still passes",
    genuine.status === 200 && (genuine.body as { text: string }).text === "Me fui de mi casa ayer",
    JSON.stringify(genuine),
  );

  // The defect as measured: gibberish MyMemory cannot place in either
  // language comes back unchanged, `responseStatus: "200"`, no warning.
  stubFetch({ responseData: { translatedText: "zzz qqq" }, responseStatus: 200 });
  const gibberish = await postTranslate("zzz qqq");
  assert("byte-identical gibberish is refused", gibberish.status === 502, JSON.stringify(gibberish));

  // Trim and case-fold: the comparison this route now makes. A reply that
  // differs from the request only in case or in outer whitespace answered
  // nothing either.
  stubFetch({ responseData: { translatedText: "  ZZZ   QQQ  " }, responseStatus: 200 });
  const foldedEcho = await postTranslate("zzz qqq");
  assert(
    "an echo that only differs in case or spacing is refused too",
    foldedEcho.status === 502,
    JSON.stringify(foldedEcho),
  );

  // The known cost: a name that legitimately holds still across English and
  // Spanish reads exactly like an echo, and is refused the same way. RL-59
  // hands this to the per-word breakdown instead of the network badge —
  // an honest "could not answer", not a wrong one.
  stubFetch({ responseData: { translatedText: "Harry Potter" }, responseStatus: 200 });
  const properNoun = await postTranslate("Harry Potter");
  assert(
    "a proper noun that translates to itself pays the same refusal (known cost)",
    properNoun.status === 502,
    JSON.stringify(properNoun),
  );

  // The two branches this route already had, both still standing.
  stubFetch({ responseData: { translatedText: "" }, responseStatus: 200 });
  const empty = await postTranslate("something to translate");
  assert("an empty translatedText is still refused", empty.status === 502, JSON.stringify(empty));

  stubFetch({ responseData: { translatedText: "MYMEMORY WARNING: YOU USED ALL AVAILABLE FREE TRANSLATIONS" }, responseStatus: "160" });
  const quota = await postTranslate("something to translate");
  assert("a quota warning is still refused", quota.status === 502, JSON.stringify(quota));

  // RL-60, the defect as measured: MyMemory's best-scoring match for "the
  // cat sat on the mat" carries `translatedText: ""`, but `matches` holds a
  // second entry that actually answers the sentence. This is that exact
  // reply, trimmed to the fields the route reads.
  stubFetch({
    responseData: { translatedText: "" },
    responseStatus: 200,
    matches: [
      { translation: "", quality: "100", match: 0.99 },
      { translation: "El gato se sentó en la alfombra", quality: "74", match: 0.98 },
      { translation: "El gato se sentó en la alfombra.", quality: "74", match: 0.97 },
    ],
  });
  const catOnTheMat = await postTranslate("the cat sat on the mat");
  assert(
    "an empty main translation falls back to a usable match",
    catOnTheMat.status === 200 &&
      (catOnTheMat.body as { text: string }).text === "El gato se sentó en la alfombra",
    JSON.stringify(catOnTheMat),
  );

  // No usable alternative anywhere in `matches` — the route still refuses,
  // exactly as it did before this fix.
  stubFetch({
    responseData: { translatedText: "" },
    responseStatus: 200,
    matches: [
      { translation: "", match: 0.9 },
      { translation: "the cat sat on the mat", match: 0.5 },
    ],
  });
  const noAlternative = await postTranslate("the cat sat on the mat");
  assert(
    "an empty main translation with no usable match is still refused",
    noAlternative.status === 502,
    JSON.stringify(noAlternative),
  );

  // A quota warning landing inside a match (never seen live, only guarded
  // against) is skipped by the same filter the main translation answers to,
  // and the fallback keeps looking past it.
  stubFetch({
    responseData: { translatedText: "" },
    responseStatus: 200,
    matches: [
      { translation: "MYMEMORY WARNING: YOU USED ALL AVAILABLE FREE TRANSLATIONS", match: 0.99 },
      { translation: "Traducción alterna válida", match: 0.5 },
    ],
  });
  const warningInMatch = await postTranslate("something to translate");
  assert(
    "a warning string inside matches is skipped, not handed to the reader",
    warningInMatch.status === 200 &&
      (warningInMatch.body as { text: string }).text === "Traducción alterna válida",
    JSON.stringify(warningInMatch),
  );

  // "Best" is the highest-scoring usable match, not the first one in the
  // array — the fallback must not lean on MyMemory's own ordering.
  stubFetch({
    responseData: { translatedText: "" },
    responseStatus: 200,
    matches: [
      { translation: "Peor opción", match: 0.4 },
      { translation: "Mejor opción", match: 0.9 },
    ],
  });
  const bestScoring = await postTranslate("something to translate");
  assert(
    "the fallback picks the highest-scoring usable match, not the first one",
    bestScoring.status === 200 && (bestScoring.body as { text: string }).text === "Mejor opción",
    JSON.stringify(bestScoring),
  );

  // A non-200 `responseStatus` is refused **by that check alone**. The quota
  // case above passes this line too, but it also carries the warning prefix,
  // so it dies in `isUsableTranslation` and says nothing about the guard.
  // Written 2026-09-19 after a mutant deleted the `responseStatus` guard
  // whole and this suite stayed green: any non-200 reply whose text merely
  // reads like a translation would have reached the reader as one.
  stubFetch({
    responseData: { translatedText: "Una frase que parece una traducción" },
    responseStatus: "429",
    matches: [{ translation: "Otra que también lo parece", match: 0.99 }],
  });
  const plainNon200 = await postTranslate("something to translate");
  assert(
    "a non-200 responseStatus is refused even when its text looks like a translation",
    plainNon200.status === 502,
    JSON.stringify(plainNon200),
  );

  // Two usable matches at the same score: the first one wins. The tie is the
  // only part of the ranking the suite did not exercise, so `>` could become
  // `>=` unnoticed and the comment above it stop being true.
  stubFetch({
    responseData: { translatedText: "" },
    responseStatus: 200,
    matches: [
      { translation: "La primera de dos iguales", match: 0.9 },
      { translation: "La segunda de dos iguales", match: 0.9 },
    ],
  });
  const tie = await postTranslate("something to translate");
  assert(
    "a tie in score keeps the first usable match, not the last",
    tie.status === 200 && (tie.body as { text: string }).text === "La primera de dos iguales",
    JSON.stringify(tie),
  );

  await checkClientCap();

  process.exit(failed ? 1 : 0);
}

const CAP_IP = "198.51.100.31";
const NO_KEY_TEXT = "a sentence from a caller with no address";
const unscopedKey = clientKeyFromAddress(CAP_IP, SALT);
const translateKey = scopeClientKey("translate", unscopedKey)!;

async function checkClientCap(): Promise<void> {
  const sql = postgres(process.env.DATABASE_URL!, { prepare: false, max: 1 });
  const keys = [unscopedKey, translateKey, scopeClientKey("text", unscopedKey)!];
  const clear = () => sql`delete from reading.client_spend where day = current_date and client = any(${keys})`;
  async function calls(client: string): Promise<number | null> {
    const [row] = await sql<{ calls: number }[]>`
      select calls from reading.client_spend where day = current_date and client = ${client}`;
    return row?.calls ?? null;
  }

  let providerCalls = 0;
  globalThis.fetch = (async () => {
    providerCalls += 1;
    return Response.json({ responseData: { translatedText: "Una traducción" }, responseStatus: 200 });
  }) as typeof fetch;

  try {
    await clear();
    // The row `/api/word/unlisted` and `/api/phrase/notes` share for this
    // caller, already spent once today: the translate cap must not read it.
    await sql`insert into reading.client_spend (day, client, calls) values (current_date, ${unscopedKey}, 1)`;

    const statuses: number[] = [];
    for (let i = 0; i < CLIENT_CAP + 1; i += 1) {
      statuses.push((await postTranslate(`sentence number ${i} to translate`, CAP_IP)).status);
    }
    assert(
      `the third sentence of one caller at TRANSLATE_DAILY_CLIENT_CAP=${CLIENT_CAP} answers 429 without MyMemory`,
      statuses.join() === "200,200,429" && providerCalls === CLIENT_CAP,
      `statuses=${statuses.join()} providerCalls=${providerCalls}`,
    );
    const translateCalls = await calls(translateKey);
    assert(
      "the refused sentence left the caller's translate: counter at the cap",
      translateCalls === CLIENT_CAP,
      `translate client_spend=${translateCalls}`,
    );
    const sharedCalls = await calls(unscopedKey);
    assert(
      "the translate: row never moves the row unlisted and notes share",
      sharedCalls === 1,
      `shared client_spend=${sharedCalls}`,
    );

    providerCalls = 0;
    const noKey: number[] = [];
    for (let i = 0; i < CLIENT_CAP + 1; i += 1) noKey.push((await postTranslate(NO_KEY_TEXT)).status);
    assert(
      "a caller with no address to key is never capped",
      noKey.join() === "200,200,200" && providerCalls === CLIENT_CAP + 1,
      `statuses=${noKey.join()} providerCalls=${providerCalls}`,
    );

    // A provider that never answers on its own: only the route's deadline
    // ends the request. The watchdog is what a missing deadline runs into.
    globalThis.fetch = ((_input: RequestInfo | URL, init?: RequestInit) =>
      new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener("abort", () => reject(init.signal?.reason));
      })) as typeof fetch;
    const deadlineMs = 10_000;
    const started = Date.now();
    const hung = await Promise.race([
      postTranslate("a sentence nobody answers"),
      new Promise<{ status: number; body: unknown }>((resolve) =>
        setTimeout(() => resolve({ status: -1, body: "watchdog" }), deadlineMs + 3_000),
      ),
    ]);
    const elapsed = Date.now() - started;
    assert(
      `a provider that never answers gives 502 within the ${deadlineMs / 1000} s deadline`,
      hung.status === 502 && elapsed <= deadlineMs + 1_000,
      `status=${hung.status} elapsed=${elapsed}ms`,
    );
  } finally {
    await clear();
    await sql.end();
  }
}

main().catch((error: unknown) => {
  console.error(error);
  process.exit(1);
});
