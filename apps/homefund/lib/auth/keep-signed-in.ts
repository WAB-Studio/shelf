import "server-only";

import { KEEP_SIGNED_IN_KEY } from "@/lib/auth/inactivity";
import { createSupabaseServerClient } from "@/lib/supabase/server";
import { choiceOfDays } from "@/lib/validation/session";

/**
 * The stored «Mantener la sesión abierta» choice (RF-190), read from Auth: the token's claims carry a
 * new limit only after the proxy's next refresh, so a select fed from them would show the old one.
 */
export async function readKeepSignedIn(): Promise<string> {
  const supabase = await createSupabaseServerClient();
  const { data } = await supabase.auth.getUser();
  const days = data.user?.user_metadata?.[KEEP_SIGNED_IN_KEY];

  return choiceOfDays(typeof days === "number" && days > 0 ? days : null);
}
