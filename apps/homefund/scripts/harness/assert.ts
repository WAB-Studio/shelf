// The assertion pair `scripts/check-rls.ts` writes inline, lifted so every
// harness layer reports the same three columns. Each layer numbers its own
// series behind its own prefix, so `Q1` here never collides with check-rls's 1.

let failed = false;
let passes = 0;
let failures = 0;
let skips = 0;

export function assert(label: string, ok: boolean, detail: string): void {
  console.log(`${ok ? "PASS" : "FAIL"}  ${label} — ${detail}`);
  if (ok) passes += 1;
  else {
    failures += 1;
    failed = true;
  }
}

// Passes nothing: a skipped assertion proves nothing about the code under it,
// and never turns a red run green.
export function skip(label: string, detail: string): void {
  console.log(`SKIP  ${label} — ${detail}`);
  skips += 1;
}

export function report(): never {
  console.log("");
  console.log(`REPORT  ${passes} pass, ${failures} fail, ${skips} skip`);

  process.exit(failed ? 1 : 0);
}
