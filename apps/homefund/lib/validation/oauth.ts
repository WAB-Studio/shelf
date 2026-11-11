import { z } from "zod";

// The request the consent screen carries (RF-168). `resource`, when the client names one, has to be `/mcp` of
// a host this app serves, with or without a trailing slash: a code is issued for one audience and no other.
// `scope` is not read, so a parse drops it.
export function authorizationRequestSchema(origins: string[]) {
  const resources = origins.map((origin) => `${origin.replace(/\/+$/, "")}/mcp`);

  return z.object({
    response_type: z.literal("code"),
    client_id: z.uuid(),
    redirect_uri: z.string().min(1).max(2048).refine((value) => URL.canParse(value)),
    code_challenge: z.string().regex(/^[A-Za-z0-9_-]{43}$/),
    code_challenge_method: z.literal("S256"),
    state: z.string().max(500).optional(),
    resource: z
      .string()
      .refine((value) => resources.includes(value.replace(/\/$/, "")))
      .optional(),
  });
}

export type AuthorizationRequest = z.infer<ReturnType<typeof authorizationRequestSchema>>;

// Where the person goes back to: only ever a redirect the client registered, with the code or the refusal
// and the client's own `state`. The error redirect is as much an open redirect as the success one.
export function redirectBack(request: AuthorizationRequest, params: Record<string, string>): string {
  const url = new URL(request.redirect_uri);
  for (const [name, value] of Object.entries(params)) url.searchParams.set(name, value);
  if (request.state !== undefined) url.searchParams.set("state", request.state);

  return url.toString();
}
