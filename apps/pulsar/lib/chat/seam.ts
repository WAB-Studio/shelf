export type ChatStub = { kind: "fail" } | { kind: "script"; path: string };

/**
 * What a test server answers in place of the model, so no suite ever spends
 * (RNP-21). `seam` is `PULSAR_CHAT_STUB`: `fail` or `script:<path to a JSON
 * file>`; `vercel` is `VERCEL`, set in every build and deployment, and any
 * value of it switches the seam off. Not `NODE_ENV`: `next start` runs as
 * `production` too, and that is the server a spec drives. A value it does not
 * know is off, never a guess.
 */
export function chatStub(seam: string | undefined, vercel: string | undefined): ChatStub | null {
  if (vercel || !seam) return null;
  const value = seam.trim();
  if (value === "fail") return { kind: "fail" };
  if (value.startsWith("script:") && value.length > "script:".length) {
    return { kind: "script", path: value.slice("script:".length) };
  }
  return null;
}
