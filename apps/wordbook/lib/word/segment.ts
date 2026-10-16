// The word-history shell reads the word off the address, still
// percent-encoded. A hand-typed malformed escape keeps the raw segment, the
// text the person typed; a well-formed one decodes exactly once, so `%2525`
// is the text `%25`.
export function decodeWordSegment(segment: string): string {
  try {
    return decodeURIComponent(segment);
  } catch {
    return segment;
  }
}
