export type AnnounceInput = {
  kind: "empty" | "word" | "phrase";
  // Senses on the entry on screen; null while no entry is.
  senseCount: number | null;
  // True while a prefix mid-word holds the suggestions list instead of an answer.
  suggesting: boolean;
  network: "pending" | "resolved" | "failed" | "absent";
  decoration: "pending" | "resolved" | "absent";
  phrase: "idle" | "waiting" | "translating" | "done" | "failed";
};

export type Announcement = {
  polite: { key: "senses" | "noEntry" | "networkReady" | "extraReady" | "translating" | "phraseDone"; count?: number } | null;
  // Only a failure is ever assertive.
  assertive: "networkFailed" | null;
};

// One line for a screen reader about what just arrived. A late result outranks
// the sense count the dictionary already gave, since that was said earlier.
export function announce(input: AnnounceInput): Announcement {
  if (input.kind === "phrase") {
    if (input.phrase === "translating") return { polite: { key: "translating" }, assertive: null };
    if (input.phrase === "done") return { polite: { key: "phraseDone" }, assertive: null };
    return { polite: null, assertive: null };
  }
  if (input.kind === "empty") return { polite: null, assertive: null };
  if (input.network === "failed") return { polite: null, assertive: "networkFailed" };
  if (input.network === "resolved") return { polite: { key: "networkReady" }, assertive: null };
  if (input.decoration === "resolved") return { polite: { key: "extraReady" }, assertive: null };
  if (input.senseCount !== null) {
    return { polite: { key: "senses", count: input.senseCount }, assertive: null };
  }
  if (!input.suggesting && input.network === "absent") return { polite: { key: "noEntry" }, assertive: null };
  return { polite: null, assertive: null };
}
