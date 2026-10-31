import type { Metadata } from "next";
import type { ReactNode } from "react";
import { Inter, JetBrains_Mono, Space_Grotesk } from "next/font/google";
import { NextIntlClientProvider } from "next-intl";
import { getTranslations } from "next-intl/server";

import "./theme.css";

// Sentences (docs/timelog/DESIGN.md).
const sans = Inter({ variable: "--font-sans", subsets: ["latin"], display: "swap" });

// Titles: a technical grotesque with character.
const display = Space_Grotesk({ variable: "--font-display", subsets: ["latin"], weight: ["600", "700"], display: "swap" });

// Every duration.
const mono = JetBrains_Mono({ variable: "--font-mono", subsets: ["latin"], weight: ["400", "500"], display: "swap" });

export async function generateMetadata(): Promise<Metadata> {
  const t = await getTranslations("common");
  return { title: { template: `%s · ${t("brand")}`, default: t("brand") } };
}

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="es" className={`${sans.variable} ${mono.variable} ${display.variable}`}>
      <body>
        <NextIntlClientProvider>{children}</NextIntlClientProvider>
      </body>
    </html>
  );
}
