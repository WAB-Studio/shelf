"use client";

import { normaliseHeadword } from "@/lib/dictionary/format";
import { askLate, useLateAnswer, type LateResult } from "@/lib/word/late-answer";
import { NOTES_ENDPOINT, notesResponseSchema, type NotesResponse } from "./notes-protocol";

const cache = new Map<string, LateResult<NotesResponse>>();
const NONE: NotesResponse = { notes: [] };

// Null while the request is pending. Asks at once: the translation above
// already waited for its own settle.
export function usePhraseNotes(source: string, translation: string): NotesResponse | null {
  const state = useLateAnswer(
    `${normaliseHeadword(source)}\u0000${translation}`,
    (signal) => askLate(NOTES_ENDPOINT, { source, translation }, notesResponseSchema, signal),
    cache,
    0,
  );
  if (state.kind === "resolved") return state.value;
  return state.kind === "declined" || state.kind === "unreached" ? NONE : null;
}
