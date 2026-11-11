import { requireUser } from "@/db/session";
import { fetchLatestApk } from "@/lib/android-app";
import { env } from "@/lib/env";

export const runtime = "nodejs";

/**
 * The Android app's download (RF-194). Any signed-in member gets the latest release's APK,
 * streamed from the private repository; a caller with no session is sent to the login.
 */
export async function GET() {
  await requireUser();

  const token = env.ANDROID_APK_GITHUB_TOKEN;
  if (!token) return Response.json({ error: "apk_not_configured" }, { status: 503 });

  try {
    const apk = await fetchLatestApk(token);
    if (apk) return apk;
  } catch (error) {
    console.error("apk download failed", error);
  }
  return Response.json({ error: "apk_unavailable" }, { status: 503 });
}
