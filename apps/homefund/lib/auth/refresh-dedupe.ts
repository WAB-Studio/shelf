// Refresh tokens rotate: a second request that spends an already-rotated one after Auth's reuse
// interval revokes the whole session. A phone waking up sends several requests at once, each with
// its own client and the same expired access token, so each would spend the same refresh token.
// Calls with one refresh token share one answer for a short window instead.
const WINDOW_MS = 20_000;

type Snapshot = { status: number; statusText: string; headers: [string, string][]; body: string };

const answers = new Map<string, { at: number; snapshot: Promise<Snapshot> }>();

function urlOf(input: Parameters<typeof fetch>[0]): string {
  if (typeof input === "string") return input;
  return input instanceof URL ? input.href : input.url;
}

function refreshTokenOf(input: Parameters<typeof fetch>[0], init: RequestInit | undefined): string | null {
  const url = urlOf(input);
  if (!url.includes("/auth/v1/token") || !url.includes("grant_type=refresh_token")) return null;
  if (typeof init?.body !== "string") return null;

  try {
    const token = (JSON.parse(init.body) as { refresh_token?: unknown }).refresh_token;
    return typeof token === "string" && token !== "" ? token : null;
  } catch {
    return null;
  }
}

async function snapshotOf(pending: Promise<Response>): Promise<Snapshot> {
  const response = await pending;
  return {
    status: response.status,
    statusText: response.statusText,
    headers: [...response.headers.entries()],
    body: await response.text(),
  };
}

export function sharedRefreshFetch(base: typeof fetch = fetch): typeof fetch {
  return async (input, init) => {
    const refreshToken = refreshTokenOf(input, init);
    if (refreshToken === null) return base(input, init);

    const now = Date.now();
    for (const [key, entry] of answers) if (now - entry.at > WINDOW_MS) answers.delete(key);

    let entry = answers.get(refreshToken);
    if (!entry) {
      entry = { at: now, snapshot: snapshotOf(base(input, init)) };
      answers.set(refreshToken, entry);
    }

    const owned = entry;
    let snapshot: Snapshot;
    try {
      snapshot = await owned.snapshot;
    } catch (error) {
      if (answers.get(refreshToken) === owned) answers.delete(refreshToken);
      throw error;
    }
    // A refusal is not shared: the next caller asks Auth itself.
    if (snapshot.status >= 400 && answers.get(refreshToken) === owned) answers.delete(refreshToken);

    return new Response(snapshot.body, {
      status: snapshot.status,
      statusText: snapshot.statusText,
      headers: snapshot.headers,
    });
  };
}
