// The guard a route runs before it reads the body. A `text/plain` or
// urlencoded POST from another site is a CORS simple request: no preflight,
// so the browser sends it. Refusing a foreign `Origin` stops that send;
// refusing a body of the wrong type closes what a missing `Origin` lets through.
//
// The own origin is the request's host, never a configured URL: a preview
// deployment and the production alias both answer as themselves. A caller with
// no browser (curl, a spec's request context) sends no `Origin` and goes on.
export function refuseCrossSite(request: Request, accept: "json" | "multipart"): Response | null {
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
  const essence = `${accept === "json" ? "application/json" : "multipart/form-data"}`;
  if (type !== essence && !type.startsWith(`${essence};`)) {
    return Response.json({ error: "unsupportedMediaType" }, { status: 415, headers: { "Cache-Control": "no-store" } });
  }
  return null;
}
