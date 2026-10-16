// The guard every paid route runs before it reads the body. A `text/plain`
// POST from another site is a CORS simple request: no preflight, so the
// browser sends it and the route would spend on a visitor's address.
// Refusing a foreign `Origin` stops the send that matters; refusing any body
// that is not JSON closes what a missing `Origin` would let through.
//
// The own origin is the request's host, never a configured URL: a preview
// deployment and the production alias both answer as themselves. `Origin`
// is set by the browser and no page can forge it; a caller with no browser
// (curl, a spec's request context) sends none and is left to the caps.
export function refuseCrossSiteRequest(request: Request): Response | null {
  const origin = request.headers.get("origin");
  if (origin !== null) {
    const host = request.headers.get("x-forwarded-host")?.split(",")[0]?.trim()
      || request.headers.get("host")
      || new URL(request.url).host;
    let originHost: string | null = null;
    try {
      originHost = new URL(origin).host;
    } catch {
      originHost = null;
    }
    if (originHost !== host) {
      return Response.json({ error: "forbidden" }, { status: 403, headers: { "Cache-Control": "no-store" } });
    }
  }
  const type = request.headers.get("content-type")?.trim().toLowerCase() ?? "";
  if (type !== "application/json" && !type.startsWith("application/json;")) {
    return Response.json({ error: "unsupportedMediaType" }, { status: 415, headers: { "Cache-Control": "no-store" } });
  }
  return null;
}
