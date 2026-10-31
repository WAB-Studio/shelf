import { getTranslations } from "next-intl/server";

import { AppNav } from "@/components/screens/app-nav";
import { Header } from "@/components/ui";

// The header every screen shares; /entrar has no sections to show yet.
export async function AppHeader({ signedIn }: { signedIn: boolean }) {
  const t = await getTranslations("common");
  return <Header brand={t("brand")} href={signedIn ? "/" : "/entrar"}>{signedIn ? <AppNav /> : null}</Header>;
}
