import type { Metadata } from "next";
import { getTranslations } from "next-intl/server";

import { EntrarScreen } from "@/components/account/entrar-screen";

// The screen is a client component, so the title lives on this server shell.
export async function generateMetadata(): Promise<Metadata> {
  const t = await getTranslations("common.titles");
  return { title: t("entrar") };
}

export default function EntrarPage() {
  return <EntrarScreen />;
}
