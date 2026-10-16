import type { Metadata } from "next";
import { getTranslations } from "next-intl/server";
import { redirect } from "next/navigation";

import { ImportScreen } from "@/components/import/import-screen";
import { getPerson } from "@/lib/session";

// Static per route: no title reads a goal or costs a statement (RNP-01).
export async function generateMetadata(): Promise<Metadata> {
  const t = await getTranslations("common.titles");
  return { title: t("import") };
}

// The auth gate and nothing else: the whole screen is `ImportScreen`'s (RP-37).
export default async function ImportPage() {
  const person = await getPerson();
  if (!person) redirect("/entrar");

  return <ImportScreen />;
}
