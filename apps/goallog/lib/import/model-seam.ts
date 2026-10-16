export type ModelStub =
  | { kind: "draft"; path: string }
  | { kind: "fail" }
  | { kind: "invalid" }
  | { kind: "empty" };

/**
 * What a test server answers in place of the model, so no suite ever spends
 * (RNP-13). `seam` is `PULSAR_MODEL_STUB`: `draft:<path to a JSON file>`,
 * `fail`, `invalid` or `empty`; `vercel` is `VERCEL`, which Vercel sets in
 * every build and deployment, and any value of it switches the seam off. Not
 * `NODE_ENV`: `next start` runs as `production` too, and that is the server
 * a spec drives. A value it does not know is off, never a guess.
 */
export function modelStub(seam: string | undefined, vercel: string | undefined): ModelStub | null {
  if (vercel || !seam) return null;
  const value = seam.trim();
  if (value === "fail" || value === "invalid" || value === "empty") return { kind: value };
  if (value.startsWith("draft:") && value.length > "draft:".length) {
    return { kind: "draft", path: value.slice("draft:".length) };
  }
  return null;
}
