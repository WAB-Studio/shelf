import { NextResponse, type NextRequest } from "next/server";

import { check } from "@/lib/import/check";
import { placeLeftovers } from "@/lib/import/coverage";
import { normalize } from "@/lib/import/draft";
import { linesToTasks } from "@/lib/import/line-tasks";
import { MODEL_NAME, fileRoute, modelAvailable, readPlan, type PlanInput, type PlanReading } from "@/lib/import/model";
import { claimModelCall, settleModelCall, type ModelCallOutcome } from "@/lib/import/spend";
import { parseTemplate, templateSource } from "@/lib/import/template";
import { readWorkbook } from "@/lib/import/workbook";
import { getPerson } from "@/lib/session";
import { todayInZone } from "@/lib/zone";

// One real read of a 599-line roadmap took 87 s (2026-10-12); `readPlan` aborts at 240 s. It is
// Vercel's Hobby ceiling with fluid compute (300 s) that allows it: a plan without it stops at 60 s.
export const maxDuration = 300;

const MAX_BODY_BYTES = 4 * 1024 * 1024;

function reply(status: number, body: Record<string, unknown>): NextResponse {
  return NextResponse.json(body, { status, headers: { "Cache-Control": "no-store" } });
}

function fail(status: number, error: string): NextResponse {
  return reply(status, { error });
}

const NDJSON_HEADERS = { "Content-Type": "application/x-ndjson; charset=utf-8", "Cache-Control": "no-store" };

// What a reading that did not end in a draft says, as the catalogue key the stream's last line carries.
function readingError(status: Exclude<PlanReading["status"], "ok">): string {
  switch (status) {
    case "empty":
      return "import.errors.empty";
    case "invalid":
      return "import.errors.modelInvalid";
    case "unreadableType":
      return "import.errors.unreadableType";
    case "failed":
      return "import.errors.modelFailed";
  }
}

/**
 * Reads a pasted plan or one file (RP-37, RP-86, RP-98, RNP-13) in a fixed order: the template
 * and the workbook first, which need neither key nor claim and never reach the model; then a file
 * type the reader refuses, which must not spend a claim; then the key, named when absent; then
 * the claim; then the model, whose answer streams as one JSON object a line. Every branch before
 * the stream answers a body, never a 204: an absent key is a 503 a person can read.
 */
export async function POST(request: NextRequest) {
  const person = await getPerson();
  if (!person) return fail(401, "import.errors.signedOut");

  const declared = Number(request.headers.get("content-length"));
  if (declared > MAX_BODY_BYTES) return fail(413, "import.errors.tooBig");

  let form: FormData;
  try {
    form = await request.formData();
  } catch {
    return fail(422, "import.errors.blank");
  }

  const pasted = form.get("text");
  const upload = form.get("file");
  const file = upload instanceof File && upload.size > 0 ? upload : null;
  if (file && file.size > MAX_BODY_BYTES) return fail(413, "import.errors.tooBig");

  let input: PlanInput;
  let text: string | null = null;
  if (file) {
    const bytes = new Uint8Array(await file.arrayBuffer());
    input = { kind: "file", name: file.name, type: file.type, bytes };
    const kind = fileRoute(file.name, file.type);
    if (kind === "workbook") {
      const book = await readWorkbook(bytes);
      if (!book.matched) return fail(415, "import.errors.workbookNotTemplate");
      if ("errors" in book) return reply(422, { error: "import.errors.workbookRows", rows: book.errors });
      return reply(200, { via: "workbook", draft: book.draft, ...check(book.draft), source: book.source });
    }
    if (kind === "text") text = new TextDecoder().decode(bytes);
  } else if (typeof pasted === "string" && pasted.trim() !== "") {
    input = { kind: "text", text: pasted };
    text = pasted;
  } else {
    return fail(422, "import.errors.blank");
  }

  if (text !== null) {
    const template = parseTemplate(text);
    if (template.matched) {
      if ("error" in template) {
        return reply(422, { error: "import.errors.templateLine", errors: template.errors, cut: template.cut });
      }
      return reply(200, { via: "template", draft: template.draft, ...check(template.draft), source: templateSource(text) });
    }
  }

  if (file && fileRoute(file.name, file.type) === null) return fail(415, "import.errors.unreadableType");

  if (!modelAvailable()) return fail(503, "import.errors.noKey");

  const claim = await claimModelCall(MODEL_NAME, file ? "file" : "paste");
  if (!claim) return fail(429, "import.errors.cap");

  const encoder = new TextEncoder();
  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      // A person who left closed the stream; the read and the charge go on without them.
      const send = (line: Record<string, unknown>) => {
        try {
          controller.enqueue(encoder.encode(`${JSON.stringify(line)}\n`));
        } catch {}
      };
      let settled = false;
      const settle = async (outcome: ModelCallOutcome, usage?: PlanReading["usage"]) => {
        settled = true;
        await settleModelCall(claim.id, { inputTokens: usage?.input ?? 0, outputTokens: usage?.output ?? 0, outcome });
      };
      try {
        const reading = await readPlan(input, (step) => send({ step })).catch(
          (): PlanReading => ({ status: "failed" }),
        );
        // A type the model never saw has no outcome of its own: it settles as failed.
        await settle(reading.status === "unreadableType" ? "failed" : reading.status, reading.usage);
        if (reading.status !== "ok") {
          send({ error: readingError(reading.status) });
          return;
        }
        send({ step: "check" });
        const normalized = normalize(reading.raw, reading.source);
        const placed = placeLeftovers(normalized.draft, reading.source);
        const lined = linesToTasks(placed, reading.source, todayInZone(), { onlyDone: true });
        const checked = check(lined.draft);
        send({
          done: {
            via: "model",
            draft: lined.draft,
            corrections: [...normalized.corrections, ...lined.corrections, ...checked.corrections],
            notices: checked.notices,
            source: reading.source,
          },
        });
      } catch {
        if (!settled) await settle("failed").catch(() => {});
        send({ error: "import.errors.modelFailed" });
      } finally {
        try {
          controller.close();
        } catch {}
      }
    },
  });
  return new Response(stream, { headers: NDJSON_HEADERS });
}
