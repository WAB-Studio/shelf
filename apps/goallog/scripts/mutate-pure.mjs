// Runs Stryker once per pure file against only the tests that reach it, directly or through other modules:
// the tap runner has no per-test coverage, so a whole-suite run per mutant costs ~20 s.
// Usage: npm run mutate:pure -- lib/day/weeks.ts   (substring match, several allowed)
//        npm run mutate:pure -- --changed <base>   (lib files changed since <base>)
import { spawnSync } from "node:child_process";
import { existsSync, readdirSync, readFileSync, statSync, writeFileSync, mkdirSync } from "node:fs";
import { basename, dirname, join, normalize } from "node:path";

const config = JSON.parse(readFileSync("stryker.config.json", "utf8"));
const walk = (dir) =>
  readdirSync(dir, { withFileTypes: true }).flatMap((e) =>
    e.isDirectory() ? walk(join(dir, e.name)) : [join(dir, e.name)],
  );
// The roots `check:unit` globs for tests.
const tests = ["lib", "components", "scripts"].flatMap(walk).filter((f) => f.endsWith(".test.ts"));

const SPECIFIER = /(?:\bfrom\s*|\bimport\s*\(?\s*)["']([^"']+)["']/g;
const resolveSpecifier = (from, spec) => {
  if (!spec.startsWith("./") && !spec.startsWith("../") && !spec.startsWith("@/")) return null;
  const base = normalize(spec.startsWith("@/") ? spec.slice(2) : join(dirname(from), spec));
  const candidates = [base, `${base}.ts`, `${base}.tsx`, join(base, "index.ts")];
  return candidates.find((c) => existsSync(c) && statSync(c).isFile()) ?? null;
};
const closureCache = new Map();
const closureOf = (entry) => {
  if (closureCache.has(entry)) return closureCache.get(entry);
  const seen = new Set([entry]);
  const queue = [entry];
  while (queue.length) {
    const current = queue.pop();
    for (const m of readFileSync(current, "utf8").matchAll(SPECIFIER)) {
      const next = resolveSpecifier(current, m[1]);
      if (next && !seen.has(next)) {
        seen.add(next);
        queue.push(next);
      }
    }
  }
  closureCache.set(entry, seen);
  return seen;
};

const brace = (p) => {
  const m = p.match(/^(.*)\{(.*)\}(.*)$/);
  return m ? m[2].split(",").map((x) => m[1] + x + m[3]) : [p];
};
const all = config.mutate.flatMap(brace);
const args = process.argv.slice(2);
let files;
if (args[0] === "--changed") {
  if (!args[1]) throw new Error("--changed needs a base ref");
  const diff = spawnSync("git", ["diff", "--name-only", `${args[1]}...HEAD`, "--", "."], { encoding: "utf8" });
  if (diff.status !== 0) throw new Error(diff.stderr);
  const top = spawnSync("git", ["rev-parse", "--show-prefix"], { encoding: "utf8" }).stdout.trim();
  const changed = diff.stdout.split("\n").filter((f) => f.startsWith(top)).map((f) => f.slice(top.length));
  files = all.filter((f) => changed.includes(f));
  if (!files.length) console.log("No pure lib file in the allowlist changed.");
} else {
  files = args.length ? all.filter((f) => args.some((w) => f.includes(w))) : all;
}

if (!process.env.MUTATE_PURE_LIST) mkdirSync("private/stryker", { recursive: true });
let failed = 0;
for (const file of files) {
  // The basename match stays as a superset: a test that quotes the name through a mock is still run.
  const name = basename(file, ".ts");
  const covering = tests.filter(
    (t) =>
      t === file.replace(/\.ts$/, ".test.ts") ||
      closureOf(t).has(file) ||
      new RegExp(`/${name}["']`).test(readFileSync(t, "utf8")),
  );
  if (process.env.MUTATE_PURE_LIST) {
    console.log(`${file} → ${covering.join(" ")}`);
    continue;
  }
  if (!covering.length) {
    console.log(`SKIP ${file}: no test reaches it`);
    continue;
  }
  console.log(`\n== ${file} (${covering.length} test files)`);
  const slug = file.replace(/[/.]/g, "_");
  const cfgPath = `private/stryker/${slug}.config.json`;
  const cfg = {
    ...config,
    mutate: [file],
    tap: { ...config.tap, testFiles: covering },
    incrementalFile: `private/stryker/${slug}.incremental.json`,
    jsonReporter: { fileName: `private/stryker/${slug}.json` },
  };
  delete cfg.$schema;
  writeFileSync(cfgPath, JSON.stringify(cfg));
  const r = spawnSync("npx", ["stryker", "run", cfgPath], { stdio: "inherit" });
  if (r.status !== 0) failed += 1;
}
process.exit(failed ? 1 : 0);
