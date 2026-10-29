import type { ReactNode } from "react";
import { redirect } from "next/navigation";

import { AppNav } from "@/components/screens/app-nav";
import { Page } from "@/components/ui";
import { getPerson } from "@/lib/session";

// Every screen but /entrar is the person's own (RT-08).
export default async function AppLayout({ children }: { children: ReactNode }) {
  if ((await getPerson()) === null) redirect("/entrar");
  return (
    <Page>
      <AppNav />
      {children}
    </Page>
  );
}
