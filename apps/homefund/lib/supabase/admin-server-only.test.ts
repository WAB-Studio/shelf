import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { registerHooks } from "node:module";
import { test } from "node:test";
import { pathToFileURL } from "node:url";

// RF-148. The admin client carries the key that bypasses every policy, so importing it outside
// a server component must be refused by `server-only` itself. Only the env is doubled here.
// `server-only` is not a dependency of the app; Next ships it, so the hook points at that real file.

const realServerOnly = pathToFileURL(
  createRequire(import.meta.url).resolve("next/dist/compiled/server-only/index.js"),
).href;

registerHooks({
  resolve(specifier, context, nextResolve) {
    if (specifier === "@/lib/env") return { url: "double:env", shortCircuit: true };
    if (specifier === "server-only") return nextResolve(realServerOnly, context);
    return nextResolve(specifier, context);
  },
  load(url, context, nextLoad) {
    if (url === "double:env") {
      return {
        format: "module",
        shortCircuit: true,
        source: `export const env = {
          NEXT_PUBLIC_SUPABASE_URL: "http://127.0.0.1:44321",
          SUPABASE_SECRET_KEY: "sb_secret_x",
        };`,
      };
    }
    return nextLoad(url, context);
  },
});

// Mutation (cb2-05): delete `import "server-only"`.
test("importing the admin client outside a server component is refused by server-only", async () => {
  await assert.rejects(
    import("./admin"),
    (error: Error) => /cannot be imported from a Client Component module/.test(error.message),
  );
});
