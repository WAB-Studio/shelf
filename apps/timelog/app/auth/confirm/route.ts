import { createSupabaseServerClient } from "@repo/supabase-auth";
import { NextResponse, type NextRequest } from "next/server";
import { z } from "zod";

import { env } from "@/lib/env";

// `code` is the PKCE link; `token_hash` the template the apps still share.
const confirmSchema = z
  .object({
    code: z.string().min(1).optional(),
    token_hash: z.string().min(1).optional(),
    type: z.enum(["magiclink", "signup", "email"]).optional(),
  })
  .refine((query) => query.code !== undefined || (query.token_hash !== undefined && query.type !== undefined));

function redirect(request: NextRequest, path: string, headers: Headers): NextResponse {
  const response = NextResponse.redirect(new URL(path, request.url));
  headers.forEach((value, name) => response.headers.set(name, value));
  response.headers.set("Cache-Control", "no-store");
  return response;
}

// Lands the sign-in link (RT-08) on «Hoy», or back on /entrar saying why.
export async function GET(request: NextRequest) {
  const authHeaders = new Headers();
  const query = confirmSchema.safeParse(Object.fromEntries(request.nextUrl.searchParams));
  if (!query.success) return redirect(request, "/entrar?error=linkInvalid", authHeaders);

  const supabase = await createSupabaseServerClient(
    { url: env.NEXT_PUBLIC_SUPABASE_URL, publishableKey: env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY },
    authHeaders,
  );
  const { code, token_hash, type } = query.data;
  const { error } = code !== undefined
    ? await supabase.auth.exchangeCodeForSession(code)
    : await supabase.auth.verifyOtp({ type: type!, token_hash: token_hash! });
  if (error) {
    console.error("sign-in link verification failed", error);
    return redirect(request, "/entrar?error=linkInvalid", authHeaders);
  }
  return redirect(request, "/", authHeaders);
}
