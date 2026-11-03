import { z } from "zod";

import { json } from "@/lib/http/responses";
import { getReader, withReaderDb } from "@/lib/session";
import { listDevices, retireDevice } from "@/lib/sync/devices";

const retireDeviceRequestSchema = z.object({
  deviceId: z.uuid(),
});

// `getReader` reads straight off verified claims: no session, no round trip
// at all, Postgres included. Both handlers check it before opening
// `withReaderDb`, so an unauthenticated caller never touches the database.
export async function GET(): Promise<Response> {
  const reader = await getReader();
  if (!reader) return json({ error: "unauthorized" }, 401);

  const devices = await withReaderDb((tx) => listDevices(tx, reader.id));
  return json({ devices }, 200);
}

// `revalidatePath` is never called here: `/cuenta` is a client component and
// redraws its list off a fresh GET.
export async function DELETE(request: Request): Promise<Response> {
  const reader = await getReader();
  if (!reader) return json({ error: "unauthorized" }, 401);

  let raw: unknown;
  try {
    raw = await request.json();
  } catch {
    return json({ error: "invalid" }, 400);
  }

  const parsed = retireDeviceRequestSchema.safeParse(raw);
  if (!parsed.success) return json({ error: "invalid" }, 400);

  const result = await withReaderDb((tx) => retireDevice(tx, reader.id, parsed.data.deviceId));
  return json(result, 200);
}
