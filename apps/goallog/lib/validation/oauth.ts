import { z } from "zod";
import { messageKey, type MessageKey } from "@/i18n/translator";

const CLIENT_URL_BASE = "https://";
const UUID = z.uuid();

function clientIdValid(value: string): boolean {
  return UUID.safeParse(value).success || (value.startsWith(CLIENT_URL_BASE) && URL.canParse(value));
}

function redirectUriValid(value: string): boolean {
  return value.length > 0 && URL.canParse(value);
}

/**
 * The request the consent screen carries (RP-60). `resource` has to be this
 * server's own `/mcp`: a code is issued for one audience and no other. `scope`
 * is not read, so a parse drops it.
 */
export function authorizationRequestSchema(siteUrl: string) {
  const resource = `${siteUrl.replace(/\/+$/, "")}/mcp`;

  return z.object({
    response_type: z.literal("code", { error: "oauth.errors.responseType" }),
    client_id: z
      .string({ error: "oauth.errors.clientId" })
      .refine(clientIdValid, { error: "oauth.errors.clientId" }),
    redirect_uri: z
      .string({ error: "oauth.errors.redirectUri" })
      .refine(redirectUriValid, { error: "oauth.errors.redirectUri" }),
    code_challenge: z
      .string({ error: "oauth.errors.codeChallenge" })
      .regex(/^[A-Za-z0-9_-]{43}$/, { error: "oauth.errors.codeChallenge" }),
    code_challenge_method: z.literal("S256", { error: "oauth.errors.codeChallengeMethod" }),
    state: z.string({ error: "oauth.errors.state" }).max(500, { error: "oauth.errors.state" }).optional(),
    resource: z.literal(resource, { error: "oauth.errors.resource" }),
  });
}

export type AuthorizationRequest = z.infer<ReturnType<typeof authorizationRequestSchema>>;

/** The error key of the first thing wrong with a request. */
export function authorizationErrorKey(input: unknown, siteUrl: string): MessageKey | null {
  if (typeof input !== "object" || input === null) return "oauth.errors.invalid";
  const parsed = authorizationRequestSchema(siteUrl).safeParse(input);

  return parsed.success ? null : messageKey(parsed.error.issues[0].message);
}

const CONSENT_PATH = "/oauth/autorizar";

/**
 * Where a sign-in may return to: a path on this origin that is the consent
 * screen, with its query. Anything else — another origin, a protocol-relative
 * or backslashed form, a dot-segment out of the consent path — is `null`.
 */
export function consentReturnPath(next: string | null | undefined, siteUrl: string): string | null {
  if (typeof next !== "string" || !next.startsWith("/") || next.startsWith("//") || next.includes("\\")) {
    return null;
  }
  const origin = new URL(siteUrl).origin;
  let url: URL;
  try {
    url = new URL(next, origin);
  } catch {
    return null;
  }
  if (url.origin !== origin || url.pathname !== CONSENT_PATH) return null;

  return url.pathname + url.search;
}
