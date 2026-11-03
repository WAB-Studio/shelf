import { replaceDays } from "@/lib/ingest";
import { bearerOf } from "@/lib/key-format";
import { uploadSchema } from "@/lib/upload";

export const runtime = "nodejs";

// Far above a month of real days, far below what could exhaust the function's memory.
const MAX_BODY_BYTES = 8 * 1024 * 1024;

const json = (status: number, body: unknown) =>
  Response.json(body, { status, headers: { "Cache-Control": "no-store" } });

// The uploader's door (RT-02, RT-03, RT-13..RT-19): a key, a JSON body, one statement.
export async function POST(request: Request): Promise<Response> {
  const key = bearerOf(request.headers.get("authorization"));
  if (key === null) return json(401, { error: "key" });

  const declared = Number(request.headers.get("content-length") ?? 0);
  if (declared > MAX_BODY_BYTES) return json(413, { error: "size" });

  let body: unknown;
  try {
    // A chunked body declares no length; the text is measured once read.
    const text = await request.text();
    if (text.length > MAX_BODY_BYTES) return json(413, { error: "size" });
    body = JSON.parse(text);
  } catch {
    return json(400, { error: "json" });
  }

  const parsed = uploadSchema().safeParse(body);
  if (!parsed.success) {
    return json(400, { error: "shape", issues: parsed.error.issues.map((issue) => ({ path: issue.path.join("."), message: issue.message })) });
  }

  let written: number | null;
  try {
    written = await replaceDays(key, parsed.data);
  } catch (error) {
    // The name only: a driver's message carries the statement and its parameters.
    console.error("ingest failed:", error instanceof Error ? error.name : "unknown");
    return json(500, { error: "server" });
  }
  if (written === null) return json(401, { error: "key" });

  return json(200, { written, days: parsed.data.days.length });
}
