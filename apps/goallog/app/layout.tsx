import type { Metadata } from "next";
import type { ReactNode } from "react";
import { Archivo, DM_Mono } from "next/font/google";
import { NextIntlClientProvider } from "next-intl";
import { getTranslations } from "next-intl/server";
import { Theme } from "@radix-ui/themes";

import { ThemeScript } from "@/components/theme-script";
import "@radix-ui/themes/styles.css";
import "./theme.css";

// Sentences, headings, commitment names and controls (docs/pulsar/DESIGN.md "Type").
const sans = Archivo({
  variable: "--font-sans",
  subsets: ["latin"],
  fallback: ["system-ui", "sans-serif"],
  display: "swap",
});

// Every figure: hours, counts, minutes, dates and quantities.
const mono = DM_Mono({
  variable: "--font-mono",
  subsets: ["latin"],
  weight: ["400", "500"],
  fallback: ["ui-monospace", "monospace"],
  display: "swap",
});

// Every page names its place; the template adds the brand. A page without a
// title reads the default.
export async function generateMetadata(): Promise<Metadata> {
  const t = await getTranslations("common");
  return { title: { template: `%s · ${t("brand")}`, default: t("brand") } };
}

// No dynamic API here on purpose: `app/(app)/layout.tsx` is what calls
// `getPerson()` and draws the nav, scoped to the signed-in screens alone —
// this file stays static so `/entrar` and `/auth/confirm` do too.
export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html
      lang="es"
      className={`${sans.variable} ${mono.variable}`}
      // The inline script below writes the theme class here before hydration.
      suppressHydrationWarning
    >
      <head>
        <ThemeScript />
      </head>
      <body>
        <NextIntlClientProvider>
          <Theme accentColor="teal" grayColor="slate" radius="large" scaling="100%">
            {children}
          </Theme>
        </NextIntlClientProvider>
      </body>
    </html>
  );
}
