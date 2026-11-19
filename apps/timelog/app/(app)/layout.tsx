import type { ReactNode } from "react";
import { redirect } from "next/navigation";

import { AppHeader } from "@/components/screens/app-header";
import { Page } from "@/components/ui";
import { getPerson } from "@/lib/session";

// Every screen but /entrar is the person's own (RT-08), under one header and one column, so navigation never moves.
export default async function AppLayout({ children }: { children: ReactNode }) {
  if ((await getPerson()) === null) redirect("/entrar");
  return (
    <Page>
      <AppHeader signedIn />
      {children}
    </Page>
  );
}
