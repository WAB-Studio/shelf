import { registerClient } from "@/lib/oauth/grants";
import { registrationPreflight, registrationResponse } from "@/lib/oauth/register";
import { callerAddress, claimRegistration, tooMany } from "@/lib/oauth/throttle";

export const runtime = "nodejs";

export async function POST(request: Request): Promise<Response> {
  const claim = await claimRegistration(callerAddress(request));
  if (!claim.ok) return tooMany(claim.retryAfter);

  return registrationResponse(await request.json().catch(() => null), registerClient);
}

export { registrationPreflight as OPTIONS };
