import { getTranslations } from "next-intl/server";

import { AppNav } from "@/components/screens/app-nav";
import { LocaleSwitch } from "@/components/screens/locale-switch";
import { Header } from "@/components/ui";

// The header every screen shares; /entrar has no sections to show yet.
export async function AppHeader({ signedIn, sidebar }: { signedIn: boolean; sidebar?: boolean }) {
  const t = await getTranslations("common");
  return (
    <Header brand={t("brand")} href={signedIn ? "/" : "/entrar"} sidebar={sidebar}>
      {signedIn ? <AppNav vertical={sidebar} /> : null}
      <LocaleSwitch />
    </Header>
  );
}
