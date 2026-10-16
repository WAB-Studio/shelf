"use client";

import Link from "next/link";
import { Archivo, DM_Mono } from "next/font/google";
import { Theme } from "@radix-ui/themes";

import { ThemeScript } from "@/components/theme-script";
import { Button, Page, Text } from "@/components/ui";
import common from "@/messages/es/common.json";
import "@radix-ui/themes/styles.css";
import "./theme.css";

const sans = Archivo({
  variable: "--font-sans",
  subsets: ["latin"],
  fallback: ["system-ui", "sans-serif"],
  display: "swap",
});

const mono = DM_Mono({
  variable: "--font-mono",
  subsets: ["latin"],
  weight: ["400", "500"],
  fallback: ["ui-monospace", "monospace"],
  display: "swap",
});

/**
 * `Fallo.dc.html`, without the nav: the root layout itself failed, so
 * nothing above this renders — its own `<html>`, its own theme class
 * (`lib/theme.ts`'s script, the same `ThemeScript` `app/layout.tsx` mounts)
 * and its own fonts. `NextIntlClientProvider` is the one piece not rebuilt:
 * it wants the async request config `i18n/request.ts` resolves for a Server
 * Component, out of reach from a Client Component with no tree above it, so
 * the strings are read straight off `messages/es/common.json` as plain data
 * instead of through `useTranslations`.
 */
export default function GlobalError({
  retry,
}: {
  error: Error & { digest?: string };
  retry: () => void;
}) {
  const t = common.error;

  return (
    <html lang="es" className={`${sans.variable} ${mono.variable}`} suppressHydrationWarning>
      <head>
        <ThemeScript />
      </head>
      <body>
        <Theme accentColor="teal" grayColor="slate" radius="large" scaling="100%">
          <Page>
            <Text asChild variant="title">
              <h1>{t.title}</h1>
            </Text>
            <Text as="p" tone="secondary">
              {t.body}
            </Text>
            <Button block onClick={() => retry()}>
              {t.retry}
            </Button>
            <Button asChild variant="ghost" tone="accent" block>
              <Link href="/">{t.secondaryAction}</Link>
            </Button>
          </Page>
        </Theme>
      </body>
    </html>
  );
}
