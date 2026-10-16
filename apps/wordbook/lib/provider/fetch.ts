const DEFAULT_TIMEOUT_MS = 20_000;

// Logs the provider's name and status alone: never the key, the request
// body or the reader's text.
export async function providerFetch(
  url: string,
  init: RequestInit,
  { name, timeoutMs = DEFAULT_TIMEOUT_MS }: { name: string; timeoutMs?: number },
): Promise<Response | null> {
  let response: Response;
  try {
    response = await fetch(url, { ...init, signal: AbortSignal.timeout(timeoutMs) });
  } catch (error) {
    const timedOut = error instanceof Error && error.name === "TimeoutError";
    console.error(`[provider] ${name} ${timedOut ? "timeout" : "network"}`);
    return null;
  }
  if (!response.ok) {
    console.error(`[provider] ${name} ${response.status}`);
    return null;
  }
  return response;
}
