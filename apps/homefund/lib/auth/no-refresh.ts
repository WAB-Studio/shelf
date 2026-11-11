// A refresh rotates the refresh token, and only the proxy can hand the rotated one back to the
// browser: a Server Component or Action that spends it leaves the browser holding a spent token,
// and the next use past Auth's reuse interval revokes the session. Every other server client
// asks the proxy's work (the cookie it already refreshed) and is refused a refresh here.
export function neverRefreshFetch(base: typeof fetch = fetch): typeof fetch {
  return async (input, init) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    if (!url.includes("/auth/v1/token") || !url.includes("grant_type=refresh_token")) return base(input, init);

    return new Response(JSON.stringify({ code: 400, error_code: "refresh_not_allowed", msg: "Only the proxy refreshes a session" }), {
      status: 400,
      headers: { "Content-Type": "application/json" },
    });
  };
}
