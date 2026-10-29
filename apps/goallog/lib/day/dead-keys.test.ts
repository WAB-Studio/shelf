import assert from "node:assert/strict";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";

import ts from "typescript";

const root = join(import.meta.dirname, "..", "..");

function sourceFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) return sourceFiles(path);
    return /\.tsx?$/.test(name) && !name.endsWith(".test.ts") ? [path] : [];
  });
}

function readers(key: string): string[] {
  const found: string[] = [];
  for (const file of sourceFiles(join(root, "components"))) {
    const sf = ts.createSourceFile(file, readFileSync(file, "utf8"), ts.ScriptTarget.Latest, true);
    const visit = (node: ts.Node) => {
      if ((ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) && node.text === key) found.push(file);
      ts.forEachChild(node, visit);
    };
    visit(sf);
  }
  return found;
}

test("day.oneOffs.markLabel has no reader in components, so day.json does not carry it", () => {
  const day = JSON.parse(readFileSync(join(root, "messages", "es", "day.json"), "utf8")) as {
    oneOffs: Record<string, unknown>;
  };
  assert.deepEqual(readers("day.oneOffs.markLabel"), []);
  assert.equal("markLabel" in day.oneOffs, false, "a key nothing reads stays in day.json");
});

// Literal on purpose: a test that read the words from the catalogue would pass on any text.
test("an unreadable evidence source says what it asks (RP-08)", () => {
  const day = JSON.parse(readFileSync(join(root, "messages", "es", "day.json"), "utf8")) as {
    row: Record<string, unknown>;
  };
  assert.equal(day.row.unreadSourceAsks, "sin leer la fuente · pide {asks}");
});

test("day.row.unreadSource has no reader in components, so day.json does not carry it", () => {
  const day = JSON.parse(readFileSync(join(root, "messages", "es", "day.json"), "utf8")) as {
    row: Record<string, unknown>;
  };
  assert.deepEqual(readers("day.row.unreadSource"), []);
  assert.equal("unreadSource" in day.row, false, "a key nothing reads stays in day.json");
});
