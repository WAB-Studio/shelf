// Runs Stryker once per pure file against only the tests that import it:
// the tap runner has no per-test coverage, so a whole-suite run per mutant costs ~20 s.
// Usage: npm run mutate:pure -- lib/day/weeks.ts   (substring match, several allowed)
//        npm run mutate:pure -- --changed <base>   (lib files changed since <base>)
import { spawnSync } from "node:child_process";
import { readdirSync, readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { basename, join } from "node:path";

const config = JSON.parse(readFileSync("stryker.config.json", "utf8"));
const walk = (dir) =>
  readdirSync(dir, { withFileTypes: true }).flatMap((e) =>
    e.isDirectory() ? walk(join(dir, e.name)) : [join(dir, e.name)],
  );
const tests = walk("lib").filter((f) => f.endsWith(".test.ts"));

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

// Tests that build ~37k Intl formatters (lib/zone.ts) and hold 4.7 GB for 40 s: too heavy for a mutant loop.
const skipped = { "lib/day/weeks.ts": ["--test-skip-pattern=never lands before h"] };

mkdirSync("private/stryker", { recursive: true });
let failed = 0;
for (const file of files) {
  const name = basename(file, ".ts");
  const covering = tests.filter(
    (t) => t === file.replace(/\.ts$/, ".test.ts") || new RegExp(`/${name}["']`).test(readFileSync(t, "utf8")),
  );
  if (!covering.length) {
    console.log(`SKIP ${file}: no test imports it`);
    continue;
  }
  console.log(`\n== ${file} (${covering.length} test files)`);
  const slug = file.replace(/[/.]/g, "_");
  const cfgPath = `private/stryker/${slug}.config.json`;
  const cfg = {
    ...config,
    mutate: [file],
    tap: { ...config.tap, nodeArgs: [...config.tap.nodeArgs, ...(skipped[file] ?? [])], testFiles: covering },
    incrementalFile: `private/stryker/${slug}.incremental.json`,
    jsonReporter: { fileName: `private/stryker/${slug}.json` },
  };
  delete cfg.$schema;
  writeFileSync(cfgPath, JSON.stringify(cfg));
  const r = spawnSync("npx", ["stryker", "run", cfgPath], { stdio: "inherit" });
  if (r.status !== 0) failed += 1;
}
process.exit(failed ? 1 : 0);
