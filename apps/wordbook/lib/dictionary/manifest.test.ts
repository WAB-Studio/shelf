import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { test } from "node:test";

import { manifestSchema, PAYLOAD_VERSION } from "./format";

const PUBLIC = path.join(import.meta.dirname, "../../public");

test("the shipped asset's URL carries the payload version, so a new payload is a new URL", () => {
  const manifest = manifestSchema.parse(JSON.parse(readFileSync(path.join(PUBLIC, "dictionary/manifest.json"), "utf8")));
  assert.ok(manifest.asset.path.endsWith(`-v${PAYLOAD_VERSION}.json`), manifest.asset.path);
  assert.ok(existsSync(path.join(PUBLIC, manifest.asset.path)));
});
