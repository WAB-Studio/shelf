import { NextResponse, type NextRequest } from "next/server";

import { CHAT_MODEL, answerChat, chatAvailable } from "@/lib/chat/model";
import { describeChange } from "@/lib/chat/describe";
import { chatRequestSchema, type Change } from "@/lib/chat/types";
import { claimModelCall, settleModelCall } from "@/lib/import/spend";
import { loadChangeNames } from "@/lib/queries/chat";
import { getPerson } from "@/lib/session";

// The model's rounds are bounded by its own 60 s request timeout; a route past it would be cut anyway.
export const maxDuration = 60;

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function fail(status: number, error: string): NextResponse {
  return NextResponse.json({ error }, { status, headers: { "Cache-Control": "no-store" } });
}

// A model-chosen string that is no uuid would fail the whole names statement, so it never reaches it.
function idsOf(changes: Change[]) {
  const pick = (key: string) =>
    [...new Set(changes.map((change) => change.input[key]).filter((v): v is string => typeof v === "string" && UUID.test(v)))];
  return {
    goals: [...new Set([...pick("goal_id"), ...pick("parent_id")])],
    tasks: [...new Set([...pick("one_off_id"), ...pick("parent_id")])],
    commitments: pick("commitment_id"),
  };
}

/**
 * One chat message (RP-91–RP-94, RNP-21) in a fixed order: the session, the
 * body, the key, then the claim, which must precede the model; the claim is
 * settled whatever the model does. The conversation is read and answered, never
 * stored (RP-94): the only row it leaves is the call's own.
 */
export async function POST(request: NextRequest) {
  const person = await getPerson();
  if (!person) return fail(401, "chat.errors.signedOut");

  const body = chatRequestSchema.safeParse(await request.json().catch(() => null));
  if (!body.success) return fail(422, "chat.errors.blank");

  if (!chatAvailable()) return fail(503, "chat.errors.noKey");

  const claim = await claimModelCall(CHAT_MODEL, "chat");
  if (!claim) return fail(429, "chat.errors.cap");

  const answer = await answerChat(body.data.turns).catch((): Awaited<ReturnType<typeof answerChat>> => ({ status: "failed" }));
  await settleModelCall(claim.id, {
    inputTokens: answer.usage?.input ?? 0,
    outputTokens: answer.usage?.output ?? 0,
    outcome: answer.status,
  });
  if (answer.status !== "ok") return fail(502, "chat.errors.failed");

  try {
    const names = await loadChangeNames(idsOf(answer.changes));
    const changes = answer.changes.map((change) => {
      const described = describeChange(change, names);
      return "refused" in described
        ? { id: change.id, tool: change.tool, input: change.input, refused: described.refused }
        : { id: change.id, tool: change.tool, input: change.input, words: described };
    });
    return NextResponse.json({ reply: answer.reply, changes }, { headers: { "Cache-Control": "no-store" } });
  } catch {
    return fail(502, "chat.errors.failed");
  }
}
