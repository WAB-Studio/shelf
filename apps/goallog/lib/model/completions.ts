const CHAT_COMPLETIONS_ENDPOINT = "https://api.openai.com/v1/chat/completions";

// The one POST to Chat Completions. Each caller keeps its body, its limit (the `signal`), its reading of
// the answer and its spend row; the response comes back unread.
export function postCompletion({ apiKey, body, signal }: { apiKey: string; body: unknown; signal: AbortSignal }): Promise<Response> {
  return fetch(CHAT_COMPLETIONS_ENDPOINT, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${apiKey}` },
    body: JSON.stringify(body),
    signal,
  });
}
