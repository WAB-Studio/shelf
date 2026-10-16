"use client";

import type { GeneratedTextState as TextState } from "@/components/search/generated-text";
import { PHRASE_DEBOUNCE_MS } from "@/lib/query/settle";
import { askLate, useLateAnswer, type LateResult } from "./late-answer";
import { TEXT_ENDPOINT, textResponseSchema, type WordText } from "./protocol";

const ABSENT: TextState = { kind: "absent" };
const PENDING: TextState = { kind: "pending" };

// An answer or a 204 stays for the tab's life (RL-35, RL-41); a request that
// did not get through is asked again.
const cache = new Map<string, LateResult<WordText>>();

// The one place the decoration's network call leaves the device. `headword`
// is set only once a `word` query is classified and painted.
export function useDecoration(headword: string | null, needDefinition: boolean): TextState {
  const state = useLateAnswer(
    headword,
    (signal) => askLate(TEXT_ENDPOINT, { headword, needDefinition }, textResponseSchema, signal),
    cache,
    PHRASE_DEBOUNCE_MS,
  );
  if (state.kind === "resolved") return { kind: "resolved", text: state.value };
  return state.kind === "pending" ? PENDING : ABSENT;
}
