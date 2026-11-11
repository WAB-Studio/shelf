"use client";

import Link from "next/link";
import localFont from "next/font/local";
import { Theme } from "@radix-ui/themes";

import { ThemeScript } from "@/components/theme-script";
import { Button, Page, Text } from "@/components/ui";
import common from "@/messages/es/common.json";
import "@radix-ui/themes/styles.css";
import "./theme.css";

const sans = localFont({
  src: "./fonts/archivo.woff2",
  weight: "100 900",
  variable: "--font-sans",
  fallback: ["system-ui", "sans-serif"],
  display: "swap",
});

const display = localFont({
  src: "./fonts/archivo-black.woff2",
  weight: "400",
  variable: "--font-display",
  fallback: ["Archivo", "system-ui", "sans-serif"],
  display: "swap",
});

const mono = localFont({
  src: [
    { path: "./fonts/dm-mono-400.woff2", weight: "400" },
    { path: "./fonts/dm-mono-500.woff2", weight: "500" },
  ],
  variable: "--font-mono",
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
    <html lang="es" className={`${sans.variable} ${display.variable} ${mono.variable}`} suppressHydrationWarning>
      <head>
        <ThemeScript />
      </head>
      <body>
        <Theme accentColor="orange" grayColor="slate" radius="large" scaling="100%">
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
