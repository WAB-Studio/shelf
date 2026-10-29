import { translateRequestSchema, type TranslationResult } from "./types";

// Client and server validate the same shape: the route this posts to parses
// `translateRequestSchema` too, so the two never drift apart (RL-09).
export async function translateOverNetwork(
  text: string,
  options?: { signal?: AbortSignal },
): Promise<TranslationResult> {
  const body = translateRequestSchema.parse({ text });

  const response = await fetch("/api/translate", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
    // Honouring the caller's signal is what RNL-05's cancellation rests on:
    // a superseded sentence must actually stop the request in flight.
    signal: options?.signal,
  });

  if (!response.ok) {
    throw new Error(`translate route answered ${response.status}`);
  }

  return (await response.json()) as TranslationResult;
}
