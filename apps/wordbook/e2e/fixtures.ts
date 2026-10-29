import { assertSuiteDatabase } from "@repo/harness-registry";
import { test as base, expect } from "@playwright/test";
import type { Page } from "@playwright/test";

// `registro`, `offline` and `sync` insert `auth.users` rows on `MIGRATION_DATABASE_URL`; with
// none set, no spec can write. Specs without a database keep running.
if (process.env.MIGRATION_DATABASE_URL) assertSuiteDatabase();

// `/api/word/text` calls the model and spends the user's own OpenAI money;
// `/api/word/unlisted` and `/api/phrase/notes` are the same kind of paid,
// cached route for RL-44/RL-47 and RL-46. Every spec in this suite gets all
// three routes intercepted and answered deterministically by default —
// importing `test`/`expect` from here, instead of `@playwright/test`
// directly, is what turns the interception on. A spec that needs a real
// route says so through `allowRealWordRoute` below, with a reason, in its
// own comment.
type WordRouteName = "text" | "unlisted" | "notes";

type WordTextBody = { definition: string | null; example: { en: string; es: string } };

type UnlistedBody = {
  translations: string[];
  definition: string | null;
  example: { en: string; es: string };
  lemma: string | null;
  rule: string | null;
};

type PhraseNotesBody = { notes: Array<{ term: string; note: string }> };

// Tags every response this file fabricates, so the watchdog below can tell
// "a stub answered" from "the real route answered" without trusting that
// every caller remembered to opt in — the same gap `OPENAI_API_KEY=""`
// left, as a convention rather than a guard.
export const STUB_HEADER = "x-e2e-word-stub";

// Each route is a single POST with no subpath, so matching on pathname
// alone — ignoring `?headword=...` — catches every request it makes, with
// nothing left over to match separately.
function wordRouteName(url: URL): WordRouteName | null {
  if (url.pathname === "/api/word/text") return "text";
  if (url.pathname === "/api/word/unlisted") return "unlisted";
  if (url.pathname === "/api/phrase/notes") return "notes";
  return null;
}

// One scripted answer to one request of a route. `abort` is a request that
// never reaches the server; `status` answers with that code and an empty
// body; `ok` answers 200 with the body; `hold` keeps the request open until
// `releaseWordRoute` lets it answer 204.
export type WordRouteStep =
  | { kind: "abort" }
  | { kind: "status"; status: number }
  | { kind: "ok"; body: unknown }
  | { kind: "hold" };

type WordRouteState = {
  opted: Set<WordRouteName>;
  script: Map<WordRouteName, WordRouteStep[]>;
  held: Map<WordRouteName, () => void>;
  textBody: WordTextBody | null;
  unlistedBody: UnlistedBody | null;
  phraseNotesBody: PhraseNotesBody | null;
};

type WordRouteFixtures = {
  wordRouteState: WordRouteState;
  // Lets the rest of a test's own body reach the real route for one of the
  // three endpoints. `reason` must say why; an empty one throws, so a caller
  // cannot opt out silently.
  allowRealWordRoute(route: WordRouteName, reason: string): Promise<void>;
  // Replaces the default absent (204) text answer with a generated one —
  // still fully mocked, never the real route.
  stubWordText(body: WordTextBody): Promise<void>;
  // Same shape as `stubWordText`, for `/api/word/unlisted` (RL-44, RL-47).
  stubUnlisted(body: UnlistedBody): Promise<void>;
  // Same shape as `stubWordText`, for `/api/phrase/notes` (RL-46).
  stubPhraseNotes(body: PhraseNotesBody): Promise<void>;
  // Answers the route's next requests with these steps, one per request in
  // order; once they run out the route answers as the stubs above say. Every
  // answer it fabricates carries `STUB_HEADER`.
  scriptWordRoute(route: WordRouteName, steps: WordRouteStep[]): Promise<void>;
  // Lets a request a `hold` step is keeping open answer 204.
  releaseWordRoute(route: WordRouteName): Promise<void>;
};

export const test = base.extend<WordRouteFixtures>({
  // Named `provide`, not Playwright's own `use`: an identically-named
  // parameter here reads to `eslint-plugin-react-hooks` as the `use` hook,
  // which this file, being test wiring rather than a component, is not.
  wordRouteState: async ({}, provide) => {
    await provide({
      opted: new Set(),
      script: new Map(),
      held: new Map(),
      textBody: null,
      unlistedBody: null,
      phraseNotesBody: null,
    });
  },

  // Overriding the built-in `context`, not `page`: `log.spec.ts` opens
  // further pages with `context.newPage()`, and those must stay caught
  // too. `page` is Playwright's own child of this context, so it inherits
  // the routing below with nothing extra wired here.
  context: async ({ context, wordRouteState }, provide) => {
    const escapes: string[] = [];

    await context.route(
      (url) => wordRouteName(url) !== null,
      (route) => {
        const name = wordRouteName(new URL(route.request().url()))!;
        if (wordRouteState.opted.has(name)) {
          void route.continue();
          return;
        }
        const step = wordRouteState.script.get(name)?.shift();
        if (step) {
          if (step.kind === "abort") void route.abort("failed");
          else if (step.kind === "status")
            void route.fulfill({ status: step.status, headers: { [STUB_HEADER]: "1" } });
          else if (step.kind === "ok")
            void route.fulfill({
              status: 200,
              contentType: "application/json",
              headers: { [STUB_HEADER]: "1" },
              body: JSON.stringify(step.body),
            });
          else
            wordRouteState.held.set(name, () => {
              void route.fulfill({ status: 204, headers: { [STUB_HEADER]: "1" } }).catch(() => {});
            });
          return;
        }
        const fabricated =
          name === "text"
            ? wordRouteState.textBody
            : name === "unlisted"
              ? wordRouteState.unlistedBody
              : name === "notes"
                ? wordRouteState.phraseNotesBody
                : null;
        if (fabricated) {
          void route.fulfill({
            status: 200,
            contentType: "application/json",
            headers: { [STUB_HEADER]: "1" },
            body: JSON.stringify(fabricated),
          });
          return;
        }
        // RL-35's absent shape: no connection, no provider, no cap left —
        // the same screen every route already draws with nothing to show.
        void route.fulfill({ status: 204, headers: { [STUB_HEADER]: "1" } });
      },
    );

    // The provable half of the default: every response either route ever
    // gives, in this context or a page it opens, is checked here — not
    // just assumed to have gone through the handler above. A response
    // opted into is real on purpose; one carrying neither the opt-in nor
    // this file's own marker reached the real route some other way, which
    // is exactly the gap `allowRealWordRoute` exists to close on purpose
    // instead of by accident.
    context.on("response", (response) => {
      const name = wordRouteName(new URL(response.url()));
      if (!name || wordRouteState.opted.has(name)) return;
      if (response.headers()[STUB_HEADER] === "1") return;
      escapes.push(`${response.request().method()} ${response.url()} -> ${response.status()}`);
    });

    await provide(context);

    if (escapes.length > 0) {
      throw new Error(
        "a word or phrase route escaped the default interception, reaching the real server:\n" +
          escapes.join("\n") +
          "\nOpt in with allowRealWordRoute() and say why, or fix the stub.",
      );
    }
  },

  allowRealWordRoute: async ({ wordRouteState }, provide) => {
    await provide(async (route, reason) => {
      if (!reason.trim()) throw new Error("allowRealWordRoute needs a reason");
      wordRouteState.opted.add(route);
    });
  },

  stubWordText: async ({ wordRouteState }, provide) => {
    await provide(async (body) => {
      wordRouteState.textBody = body;
    });
  },

  stubUnlisted: async ({ wordRouteState }, provide) => {
    await provide(async (body) => {
      wordRouteState.unlistedBody = body;
    });
  },

  stubPhraseNotes: async ({ wordRouteState }, provide) => {
    await provide(async (body) => {
      wordRouteState.phraseNotesBody = body;
    });
  },

  scriptWordRoute: async ({ wordRouteState }, provide) => {
    await provide(async (route, steps) => {
      wordRouteState.script.set(route, [...steps]);
    });
  },

  releaseWordRoute: async ({ wordRouteState }, provide) => {
    await provide(async (route) => {
      wordRouteState.held.get(route)?.();
      wordRouteState.held.delete(route);
    });
  },
});

// The approved words of the board `CuentaCopiaConfirmar` (docs/wordbook/DESIGN.md,
// 2026-10-08). The key the worker adds to `messages/es.json` is
// `account.copy.confirmAction`; until it exists the literal stands here.
export const COPY_CONFIRM_LABEL = "Empezar a copiar";

// The one gesture that starts a copy: with a session open and the copy not yet
// confirmed, `/cuenta` sends nothing until this button is tapped. Resolves once
// the tap landed; callers wait for the response they care about themselves.
export async function confirmCopy(page: Page): Promise<void> {
  await page.getByRole("button", { name: COPY_CONFIRM_LABEL }).click();
}

export { expect };

// Freezes the page's timers so a debounce is advanced by hand with
// `page.clock.runFor`, never raced against the wall clock. Call it once the
// dictionary is ready: before that the worker's own boot is on timers.
export async function freezeTimers(page: Page): Promise<void> {
  await page.clock.install();
  await page.clock.pauseAt(Date.now() + 1_000);
}

// Lets the page run the tasks its last event queued (a settled fetch, a
// commit). Timers are frozen, so a turn of the task queue is the only thing
// that moves.
export async function pageTasks(page: Page): Promise<void> {
  await page.evaluate(async () => {
    for (let i = 0; i < 3; i++) {
      await new Promise<void>((resolve) => {
        const channel = new MessageChannel();
        channel.port1.onmessage = () => resolve();
        channel.port2.postMessage(0);
      });
    }
  });
}

// Runs the frozen clock past `ms` and lets what the timers started reach
// the network and the screen.
export async function runClock(page: Page, ms: number): Promise<void> {
  await page.clock.runFor(ms);
  await pageTasks(page);
}

// Two animation frames: React has committed whatever the last event set and
// the browser has laid it out. A measurement right after the event alone
// reads the frame before.
export async function afterFrames(page: Page): Promise<void> {
  await page.evaluate(
    () => new Promise<void>((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))),
  );
}
