"use client";

import { Fraunces, IBM_Plex_Sans } from "next/font/google";
import { NextIntlClientProvider, useTranslations } from "next-intl";
import { THEME_BOOT_SCRIPT } from "@/lib/theme-choice";

import messages from "@/messages/es.json";
import { AppTheme, Button, Flex, Headword, Separator } from "@/components/ui";
import "@radix-ui/themes/styles.css";
import "./theme.css";

// A segment's own error.tsx never catches what breaks in that segment's own
// layout — only this file, one level above every layout, does. It replaces
// `app/layout.tsx` outright while it is mounted, so it carries its own
// `<html>`/`<body>`, fonts and stylesheets rather than assuming the ones the
// root layout would have set are still in force.
const sans = IBM_Plex_Sans({
  variable: "--font-sans",
  subsets: ["latin"],
  weight: ["400", "500", "600", "700"],
  fallback: ["system-ui", "sans-serif"],
  display: "swap",
});

const display = Fraunces({
  variable: "--font-display",
  subsets: ["latin"],
  fallback: ["Georgia", "serif"],
  display: "swap",
});

// `useTranslations` needs a provider above it, and nothing above this file
// mounts one — no root layout survives to supply it. This is the one screen
// in the app that carries its own `NextIntlClientProvider` rather than
// inheriting `app/layout.tsx`'s.
function GlobalErrorBody({ reset }: { reset: () => void }) {
  const t = useTranslations("error");

  return (
    <Flex direction="column" gap="4" align="center" justify="center" flexGrow="1">
      {/* docs/wordbook/DESIGN.md "Failure": the hairline sets the break off,
          the title stays full-weight ink, the accent lives in retry alone —
          same treatment as app/error.tsx, no shell around it here. */}
      <Separator size="4" />
      <Headword align="center">{t("title")}</Headword>
      <Button size="2" onClick={reset}>
        {t("retry")}
      </Button>
    </Flex>
  );
}

export default function GlobalError({ reset }: { error: Error & { digest?: string }; reset: () => void }) {
  return (
    <html lang="es" className={`${sans.variable} ${display.variable}`} suppressHydrationWarning>
      <head>
        <script dangerouslySetInnerHTML={{ __html: THEME_BOOT_SCRIPT }} />
      </head>
      <body>
        <NextIntlClientProvider locale="es" messages={messages}>
          <AppTheme>
            <Flex direction="column" minHeight="100dvh" p="6">
              <GlobalErrorBody reset={reset} />
            </Flex>
          </AppTheme>
        </NextIntlClientProvider>
      </body>
    </html>
  );
}
