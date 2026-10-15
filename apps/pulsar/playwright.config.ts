import { defineConfig, devices } from "@playwright/test";

import { sessionFile } from "./e2e/fixtures";

// Against `next build && next start`, never `next dev`: `tema.spec.ts` reads
// the `<html>` class at the very first commit, before React ever mounts, and
// StrictMode's double effect run in dev is exactly the kind of extra pass
// that would make a flaky read of that moment look like a real flash
// (docs/TRAPS.md "StrictMode doubles a Worker count in `next dev`, and only
// there"). `npm run build` then `PORT=3204 npm run start` first, kept
// running by hand — this file starts no server of its own.
const baseURL = process.env.PULSAR_BASE_URL ?? "http://localhost:3200";

// A second `next start` of the same build with `DATABASE_URL` pointed at a
// port nothing listens on (`e2e/caida.spec.ts`). Absent, the project does not
// exist and the ordinary suite is unchanged.
const downBaseURL = process.env.PULSAR_DOWN_BASE_URL;

// A third `next start` of the same build with `PULSAR_FAULT_SEAM` set, so
// every evidence source reads as unreadable (`e2e/fuente-caida.spec.ts`) and
// the model and the chat are stubs (`e2e/importar-modelo.spec.ts`, RNP-13; `e2e/chat-modelo.spec.ts`, RNP-21).
// Absent, the project does not exist. Locally: `PULSAR_FAULT_PORT=<free port> npm run start:fault`
// beside the ordinary server, then `PULSAR_FAULT_BASE_URL=http://localhost:<that port>`.
const faultBaseURL = process.env.PULSAR_FAULT_BASE_URL;

const phone = {
  ...devices["Desktop Chrome"],
  viewport: { width: 360, height: 740 },
  hasTouch: true,
};

export default defineConfig({
  testDir: "./e2e",
  // Opens the suite's harness run, mints and seeds the lane's person under it,
  // and drops them when the last spec ends.
  globalSetup: "./scripts/harness/e2e-run.ts",
  // Gitignored, so a run leaves the tree clean.
  outputDir: "./private/playwright-results",
  workers: 2,
  // A retry would hide a flake behind a green run, which is what this layer
  // exists to find.
  retries: 0,
  reporter: [["list"]],
  use: {
    baseURL,
    // The storage state: a real, already-verified `/auth/confirm`
    // redemption. No spec opens `/entrar` or types an address (RNP-09).
    storageState: sessionFile(),
  },
  projects: [
    // RNP-07's own case: a phone, held one-handed, standing.
    {
      name: "mobile",
      use: phone,
      testIgnore: /(caida|fuente-caida|importar-modelo|chat-modelo|tope-app)\.spec\.ts/,
    },
    ...(downBaseURL
      ? [
          {
            name: "caida",
            // Anchored: `fuente-caida.spec.ts` ends in the same name.
            testMatch: /(^|[\\/])caida\.spec\.ts$/,
            use: { ...phone, baseURL: downBaseURL },
          },
        ]
      : []),
    ...(faultBaseURL
      ? [
          {
            name: "fuente",
            testMatch: /(fuente-caida|importar-modelo|chat-modelo)\.spec\.ts/,
            use: { ...phone, baseURL: faultBaseURL },
          },
        ]
      : []),
    // RP-126 spends the whole app's day, which refuses every other spec's claim while it stands: it
    // runs once `fuente` is done, on the same server.
    ...(faultBaseURL
      ? [
          {
            name: "tope-app",
            testMatch: /tope-app\.spec\.ts/,
            dependencies: ["fuente"],
            use: { ...phone, baseURL: faultBaseURL },
          },
        ]
      : []),
  ],
});
