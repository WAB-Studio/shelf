import { sql } from "drizzle-orm";

import { db } from "@/db/client";
import { env } from "@/lib/env";

// A daily touch so free-tier inactivity cannot pause the project (RNF-12).
// No user context and no table: this is deliberately outside `withUserDb`.
export async function GET(request: Request) {
  if (request.headers.get("authorization") !== `Bearer ${env.CRON_SECRET}`) {
    return Response.json({ error: "unauthorized" }, { status: 401 });
  }

  try {
    await db.execute(sql`select 1`);
    return Response.json({ ok: true, at: new Date().toISOString() });
  } catch (error) {
    console.error("keepalive failed", error);
    return Response.json({ error: "unavailable" }, { status: 503 });
  }
}
