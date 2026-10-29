"use client";

import type { NetworkAnswerState } from "@/components/search/network-answer";
import { PHRASE_DEBOUNCE_MS } from "@/lib/query/settle";
import { askLate, useLateAnswer, type LateResult } from "./late-answer";
import { UNLISTED_ENDPOINT, unlistedResponseSchema, type UnlistedAnswer } from "./unlisted-protocol";

const ABSENT: NetworkAnswerState = { kind: "absent" };
const PENDING: NetworkAnswerState = { kind: "pending" };
const FAILED: NetworkAnswerState = { kind: "failed" };

const cache = new Map<string, LateResult<UnlistedAnswer>>();

// The one place a request to `/api/word/unlisted` leaves the device.
// `holdFromKeystroke`: a word with no entry at all reads pending during the
// debounce too, so the spelling hint never shows ahead of the network's
// verdict. A form the dictionary already answers keeps absent until the
// request leaves.
export function useNetworkAnswer(word: string | null, holdFromKeystroke = false): NetworkAnswerState {
  const state = useLateAnswer(
    word,
    (signal) => askLate(UNLISTED_ENDPOINT, { word }, unlistedResponseSchema, signal),
    cache,
    PHRASE_DEBOUNCE_MS,
  );
  if (state.kind === "resolved") return { kind: "resolved", answer: state.value };
  if (state.kind === "declined" || state.kind === "unreached") return FAILED;
  if (state.kind === "pending") return PENDING;
  return word !== null && holdFromKeystroke ? PENDING : ABSENT;
}
