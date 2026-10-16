import assert from "node:assert/strict";
import path from "node:path";
import test from "node:test";

import { ESLint } from "eslint";

// RP-131: the list is read before any person exists, so `lib/auth/allowlist.ts` joins the few files that
// may hold the raw pool. Driven through the app's own lint config: every other file stays refused.
const root = path.resolve(__dirname, "../..");
const eslint = new ESLint({ cwd: root });
const importing = 'import { db } from "@/db/client";\n\nexport const pool = db;\n';

async function refusesDbClient(file: string): Promise<boolean> {
  const [result] = await eslint.lintText(importing, { filePath: path.join(root, file) });
  return result.messages.some((message) => message.ruleId === "no-restricted-imports");
}

test("lib/auth/allowlist.ts may import @/db/client", async () => {
  assert.equal(await refusesDbClient("lib/auth/allowlist.ts"), false);
});

test("its neighbours and the rest of lib/ still may not", async () => {
  for (const file of [
    "lib/auth/deliverability.ts",
    "lib/auth/verify-magic-link.ts",
    "lib/auth/allowlist-extra.ts",
    "lib/allowlist.ts",
    "lib/validation/sign-in.ts",
    "app/actions/account.ts",
  ]) {
    assert.equal(await refusesDbClient(file), true, file);
  }
});
