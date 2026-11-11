import { exchangeCode } from "@/lib/oauth/grants";
import { tokenPreflight, tokenResponse } from "@/lib/oauth/token";

export const runtime = "nodejs";

export async function POST(request: Request): Promise<Response> {
  return tokenResponse(await request.formData().catch(() => null), exchangeCode);
}

export { tokenPreflight as OPTIONS };
