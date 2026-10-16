import { defineConfig, devices } from "@playwright/test";

import { STORAGE_STATE } from "./e2e/global-setup";
import { HARNESS_LANE_SUFFIX } from "./scripts/harness/session";

// No `webServer` block: the dev server on :3000 is started and kept running by
// hand, and a second instance would refuse the port anyway.
const baseURL = process.env.HARNESS_BASE_URL ?? "http://localhost:3000";

export default defineConfig({
  testDir: "./e2e",
  // Gitignored, so a run leaves the tree clean. One directory per lane: two lanes
  // running at once would otherwise overwrite each other's artefacts.
  outputDir: `./private/playwright-results${HARNESS_LANE_SUFFIX}`,
  globalSetup: "./e2e/global-setup.ts",
  // One worker, in order: both projects drive the same rows under the same user,
  // and a spec that seeds its queue would race the other project's.
  fullyParallel: false,
  workers: 1,
  // A retry would hide a flake behind a green run, which is what this layer
  // exists to find.
  retries: 0,
  reporter: [["list"]],
  use: {
    baseURL,
    storageState: STORAGE_STATE,
  },
  projects: [
    {
      name: "desktop",
      use: { ...devices["Desktop Chrome"], viewport: { width: 1280, height: 800 } },
    },
    // RNF-08's base case: the narrow viewport is where the bottom bar and the
    // settings sheet are the only navigation.
    {
      name: "mobile",
      use: {
        ...devices["Desktop Chrome"],
        viewport: { width: 360, height: 740 },
        hasTouch: true,
      },
    },
  ],
});
