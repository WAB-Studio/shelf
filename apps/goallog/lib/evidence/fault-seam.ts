/**
 * The evidence sources a test server reads as unreadable, so a real screen
 * draws RNP-04's notice (`e2e/fuente-caida.spec.ts`). `seam` is
 * `PULSAR_FAULT_SEAM`, comma-separated keys of `goals.evidence_sources`;
 * `vercel` is `VERCEL`, which Vercel sets in every build and deployment, and
 * any value of it switches the seam off. Not `NODE_ENV`: `next start` runs as
 * `production` too, and that is the server the spec drives.
 */
export function unreadableSources(
  seam: string | undefined,
  vercel: string | undefined,
): ReadonlySet<string> {
  if (vercel || !seam) return new Set();
  return new Set(
    seam
      .split(",")
      .map((key) => key.trim())
      .filter(Boolean),
  );
}
