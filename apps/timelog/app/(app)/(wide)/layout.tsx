import type { ReactNode } from "react";

import { AppHeader } from "@/components/screens/app-header";
import { Page } from "@/components/ui";

// Hoy, a day and Semana: a block beside its rows from 1100.
export default function WideLayout({ children }: { children: ReactNode }) {
  return (
    <Page wide>
      <AppHeader signedIn />
      {children}
    </Page>
  );
}
