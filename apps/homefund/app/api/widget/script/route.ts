import { env } from "@/lib/env";
import { widgetScript } from "@/lib/widget/script";

// The widget's Scriptable script (RF-215), plain text so a person can open it in Safari and copy it.
// It carries the app's origin and no secret: the key lives in the phone's Keychain.
export function GET(): Response {
  return new Response(widgetScript(env.NEXT_PUBLIC_SITE_URL), {
    headers: {
      "Content-Type": "text/javascript; charset=utf-8",
      "Cache-Control": "public, max-age=3600",
    },
  });
}
