// Every route that answers a reader's own state or a paid call sets this:
// no shared cache may keep the answer.
export const NO_STORE = { "Cache-Control": "no-store" };

export function json(body: unknown, status: number): Response {
  return Response.json(body, { status, headers: NO_STORE });
}

export function empty(status: number): Response {
  return new Response(null, { status, headers: NO_STORE });
}
