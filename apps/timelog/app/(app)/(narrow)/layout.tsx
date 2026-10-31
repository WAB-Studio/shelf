import type { ReactNode } from "react";

import { AppHeader } from "@/components/screens/app-header";
import { Narrow, Page } from "@/components/ui";

// Llaves: a form, one narrow column.
export default function NarrowLayout({ children }: { children: ReactNode }) {
  return (
    <Page wide>
      <AppHeader signedIn />
      <Narrow>{children}</Narrow>
    </Page>
  );
}
