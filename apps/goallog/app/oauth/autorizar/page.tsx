import type { Metadata } from "next";
import { sql } from "drizzle-orm";
import { headers } from "next/headers";
import { getTranslations } from "next-intl/server";

import { Consent } from "@/components/oauth/consent";
import { Invalid } from "@/components/oauth/invalid";
import { SignedOut } from "@/components/oauth/signed-out";
import { env } from "@/lib/env";
import { clientFromMetadataUrl } from "@/lib/oauth/client-metadata";
import { redirectAllowed } from "@/lib/oauth/clients";
import { getPerson, withGoalsDb } from "@/lib/session";
import { authorizationRequestSchema } from "@/lib/validation/oauth";

type Query = Record<string, string | string[] | undefined>;

type KnownClient = { name: string; redirectUris: string[] };

async function readClient(clientId: string, redirectUri: string): Promise<KnownClient | null> {
  if (clientId.startsWith("https://")) return clientFromMetadataUrl(clientId, await headers(), {}, { redirectUri });

  const rows = await withGoalsDb((tx) =>
    tx.execute<{ client_name: string; redirect_uris: string[] }>(sql`
      select client_name, redirect_uris from goals.oauth_clients where id = ${clientId}::uuid`),
  );

  return rows.length === 0 ? null : { name: rows[0].client_name, redirectUris: rows[0].redirect_uris };
}

// What the person was sent here with, so a sign-in can bring them back to it.
function ownUrl(query: Query): string {
  const params = new URLSearchParams();
  for (const [name, value] of Object.entries(query)) {
    for (const one of Array.isArray(value) ? value : value === undefined ? [] : [value]) params.append(name, one);
  }

  return `/oauth/autorizar?${params.toString()}`;
}

// Static per route: no title reads a goal or costs a statement (RNP-01).
export async function generateMetadata(): Promise<Metadata> {
  const t = await getTranslations("common.titles");
  return { title: t("authorize") };
}

export default async function AuthorizePage({ searchParams }: { searchParams: Promise<Query> }) {
  const query = await searchParams;
  const parsed = authorizationRequestSchema(env.NEXT_PUBLIC_SITE_URL).safeParse(query);
  if (!parsed.success) return <Invalid />;
  const request = parsed.data;

  const person = await getPerson();
  if (!person) {
    // `oauth_clients` is readable to a signed-in role alone: the name waits for the sign-in.
    const t = await getTranslations("oauth");
    return <SignedOut client={t("anonymousClient")} next={ownUrl(query)} />;
  }

  const client = await readClient(request.client_id, request.redirect_uri);
  if (!client || !redirectAllowed(client, request.redirect_uri)) return <Invalid />;

  return <Consent client={client.name} email={person.email} request={request} />;
}
