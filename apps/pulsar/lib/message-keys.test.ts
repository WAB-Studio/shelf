import assert from "node:assert/strict";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import test from "node:test";

import ts from "typescript";

import { remapped } from "./import/reason-key";

const root = join(import.meta.dirname, "..");
const messagesDir = join(root, "messages", "es");

// The namespaces are the JSON files `i18n/request.ts` imports, one file per
// namespace under its own name.
function loadedNamespaces(): string[] {
  const source = readFileSync(join(root, "i18n", "request.ts"), "utf8");
  return [...source.matchAll(/messages\/es\/(\w+)\.json/g)].map((m) => m[1]);
}

const namespaces = loadedNamespaces();
const keyShape = new RegExp(`^(${namespaces.join("|")})\\.[A-Za-z0-9_.]+$`);
const templateHead = new RegExp(`^(${namespaces.join("|")})\\.`);

function sourceFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) return name === "node_modules" ? [] : sourceFiles(path);
    return /\.tsx?$/.test(name) && !name.endsWith(".test.ts") ? [path] : [];
  });
}

type Found = { key: string; at: string };

function scan(): { keys: Found[]; templates: Found[] } {
  const keys: Found[] = [];
  const templates: Found[] = [];
  const files = [...sourceFiles(join(root, "app", "actions")), ...sourceFiles(join(root, "lib"))];
  for (const file of files) {
    const sf = ts.createSourceFile(file, readFileSync(file, "utf8"), ts.ScriptTarget.Latest, true);
    const at = (node: ts.Node) =>
      `${relative(root, file)}:${sf.getLineAndCharacterOfPosition(node.getStart(sf)).line + 1}`;
    const visit = (node: ts.Node) => {
      if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) {
        if (keyShape.test(node.text)) keys.push({ key: node.text, at: at(node) });
      } else if (ts.isTemplateExpression(node) && templateHead.test(node.head.text)) {
        templates.push({ key: node.getText(sf), at: at(node) });
      }
      ts.forEachChild(node, visit);
    };
    visit(sf);
  }
  return { keys, templates };
}

// Refusal ids, not catalogue keys: `remapped` in lib/import/reason-key.ts names the sentence of each.
const REMAPPED = Object.keys(remapped);

function resolveKey(catalogues: Record<string, unknown>, key: string): unknown {
  return key.split(".").reduce<unknown>(
    (node, part) =>
      node !== null && typeof node === "object" && Object.hasOwn(node, part)
        ? (node as Record<string, unknown>)[part]
        : undefined,
    catalogues,
  );
}

function isLeaf(value: unknown): boolean {
  return typeof value === "string" || (Array.isArray(value) && value.every((v) => typeof v === "string"));
}

test("the namespaces i18n/request.ts loads are the JSON files present, mcp aside", () => {
  const present = readdirSync(messagesDir)
    .filter((f) => f.endsWith(".json") && f !== "mcp.json")
    .map((f) => f.slice(0, -".json".length));
  assert.deepEqual([...namespaces].sort(), present.sort());
});

test("every message key a server file names is a leaf in messages/es", () => {
  const catalogues = Object.fromEntries(
    namespaces.map((ns) => [ns, JSON.parse(readFileSync(join(messagesDir, `${ns}.json`), "utf8"))]),
  );
  const { keys, templates } = scan();
  assert.ok(keys.length > 0, "the scan found no key at all");

  console.log(`message keys checked: ${keys.length}`);
  console.log(`templates skipped: ${templates.length}`);
  for (const t of templates) console.log(`  skipped ${t.at}  ${t.key}`);

  const failures = keys.flatMap(({ key, at }) => {
    if (REMAPPED.includes(key)) return [];
    const value = resolveKey(catalogues, key);
    if (value === undefined) return [`${at}  ${key}  has no entry in messages/es`];
    if (!isLeaf(value)) return [`${at}  ${key}  resolves to an object, not a message`];
    return [];
  });
  assert.deepEqual(failures, []);
});

test("every remapped refusal id names a message that exists", () => {
  const catalogue = { import: JSON.parse(readFileSync(join(messagesDir, "import.json"), "utf8")) };
  const failures = Object.entries(remapped).flatMap(([id, target]) =>
    isLeaf(resolveKey(catalogue, target)) ? [] : [`${id}  maps to ${target}, which is no message in messages/es`],
  );
  assert.deepEqual(failures, []);
  assert.equal(REMAPPED.length, 4);
});

// What the server answers a workbook with: 885 returns these keys as data.
test("the keys a workbook answer carries are messages in messages/es", () => {
  const catalogue = { import: JSON.parse(readFileSync(join(messagesDir, "import.json"), "utf8")) };
  for (const key of ["import.errors.workbookRows", "import.errors.workbookRow", "import.errors.workbookNotTemplate"]) {
    assert.equal(isLeaf(resolveKey(catalogue, key)), true, key);
  }
});
