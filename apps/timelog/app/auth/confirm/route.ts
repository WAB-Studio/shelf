import { createSupabaseServerClient } from "@repo/supabase-auth";
import { NextResponse, type NextRequest } from "next/server";
import { z } from "zod";

import { supabaseConfig } from "@/lib/env";

// `code` is the PKCE link; `token_hash` the template the apps still share.
const confirmSchema = z.union([
  z.object({ code: z.string().min(1) }),
  z.object({ token_hash: z.string().min(1), type: z.enum(["magiclink", "signup", "email"]) }),
]);

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

  const supabase = await createSupabaseServerClient(supabaseConfig, authHeaders);
  const { error } = "code" in query.data
    ? await supabase.auth.exchangeCodeForSession(query.data.code)
    : await supabase.auth.verifyOtp(query.data);
  if (error) {
    console.error("sign-in link verification failed", error);
    return redirect(request, "/entrar?error=linkInvalid", authHeaders);
  }
  return redirect(request, "/", authHeaders);
}
