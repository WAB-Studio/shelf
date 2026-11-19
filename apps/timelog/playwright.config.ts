import { defineConfig, devices } from "@playwright/test";

// No `webServer` block: the lane's dev server is started by hand inside `scripts/supabase-local.sh exec`, and the specs seed
// their own person through the local stack's Auth, so they run there only.
export default defineConfig({
  testDir: "./e2e",
  outputDir: "./private/playwright-results",
  fullyParallel: false,
  workers: 1,
  retries: 0,
  reporter: [["list"]],
  use: { ...devices["Desktop Chrome"], baseURL: process.env.HARNESS_BASE_URL ?? "http://localhost:3300" },
});
