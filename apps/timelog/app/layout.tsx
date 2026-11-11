import type { Metadata } from "next";
import type { ReactNode } from "react";
import localFont from "next/font/local";
import { NextIntlClientProvider } from "next-intl";
import { getLocale, getTranslations } from "next-intl/server";

import "./theme.css";

// Sentences (docs/timelog/DESIGN.md).
const sans = localFont({ src: "./fonts/inter.woff2", weight: "100 900", variable: "--font-sans", display: "swap" });

// Titles: a technical grotesque with character.
const display = localFont({ src: "./fonts/space-grotesk.woff2", weight: "300 700", variable: "--font-display", display: "swap" });

// Every duration.
const mono = localFont({ src: "./fonts/jetbrains-mono.woff2", weight: "100 800", variable: "--font-mono", display: "swap" });

export async function generateMetadata(): Promise<Metadata> {
  const t = await getTranslations("common");
  return { title: { template: `%s · ${t("brand")}`, default: t("brand") } };
}

export default async function RootLayout({ children }: { children: ReactNode }) {
  const locale = await getLocale();
  return (
    <html lang={locale} className={`${sans.variable} ${mono.variable} ${display.variable}`}>
      <body>
        <NextIntlClientProvider>{children}</NextIntlClientProvider>
      </body>
    </html>
  );
}
