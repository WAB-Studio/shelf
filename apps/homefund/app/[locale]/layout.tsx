import { hasLocale, NextIntlClientProvider } from "next-intl";
import { getTranslations } from "next-intl/server";
import type { Metadata, Viewport } from "next";
import localFont from "next/font/local";
import { notFound } from "next/navigation";

import { ThemeScript } from "@/components/theme-script";
import { AppTheme, Flex, Toaster } from "@/components/ui";
import { routing } from "@/i18n/routing";
import { SPLASH_BACKGROUND, SPLASHES, splashMedia } from "@/lib/splash";
import "../theme.css";

// The text and its figures (DESIGN.md «Violeta y lima»).
const sans = localFont({
  src: "../fonts/figtree.woff2",
  weight: "300 900",
  variable: "--font-sans",
});

// The titles: a grotesque with character, where the screen names itself.
const heading = localFont({
  src: "../fonts/bricolage-grotesque.woff2",
  weight: "200 800",
  variable: "--font-heading",
});

const geistMono = localFont({
  src: "../fonts/geist-mono.woff2",
  weight: "100 900",
  variable: "--font-geist-mono",
});

export function generateStaticParams() {
  return routing.locales.map((locale) => ({ locale }));
}

// Lets env(safe-area-inset-*) resolve instead of 0 on a notched phone.
export const viewport: Viewport = {
  viewportFit: "cover",
  /**
   * The browser chrome and the iOS status bar paint with this, so it carries the
   * page's own background rather than the manifest's accent: anything else draws
   * a seam across the top of the screen. The theme is a device choice the
   * pre-paint script reads from storage, but a meta tag can only follow the
   * system preference, which is what that choice defaults to.
   */
  themeColor: [
    { media: "(prefers-color-scheme: light)", color: SPLASH_BACKGROUND.light },
    { media: "(prefers-color-scheme: dark)", color: SPLASH_BACKGROUND.dark },
  ],
};

export async function generateMetadata(
  props: LayoutProps<"/[locale]">,
): Promise<Metadata> {
  const { locale } = await props.params;
  if (!hasLocale(routing.locales, locale)) notFound();

  // Metadata resolves before the layout runs, so the locale travels explicitly.
  const [t, common] = await Promise.all([
    getTranslations({ locale, namespace: "metadata" }),
    getTranslations({ locale, namespace: "common" }),
  ]);

  return {
    title: t("title"),
    description: t("description"),
    /**
     * What lands the app on an iPhone home screen (RNF-08): iOS reads none of
     * the manifest, so the launch title comes from here and the icon from the
     * `apple-icon` file convention. `default` keeps the status bar opaque and
     * legible over the light theme; `black-translucent` would force white text
     * onto the off-white background.
     */
    appleWebApp: {
      capable: true,
      // Short enough for the home screen to write it under the icon whole.
      title: common("fund"),
      statusBarStyle: "default",
      // RF-188: the installed app opens on its mark instead of a white flash.
      startupImage: SPLASHES.map((splash) => ({
        url: `/splash/${splash.name}`,
        media: splashMedia(splash),
      })),
    },
  };
}

export default async function LocaleLayout(props: LayoutProps<"/[locale]">) {
  const { locale } = await props.params;
  if (!hasLocale(routing.locales, locale)) notFound();

  return (
    <html
      lang={locale}
      className={`${sans.variable} ${heading.variable} ${geistMono.variable}`}
      // The inline script below writes the theme class here before hydration.
      suppressHydrationWarning
    >
      <head>
        <ThemeScript />
      </head>
      <body>
        <NextIntlClientProvider>
          <AppTheme>
            <Flex direction="column" height="100dvh">
              <Flex direction="column" flexGrow="1">
                {props.children}
              </Flex>
              <Toaster />
            </Flex>
          </AppTheme>
        </NextIntlClientProvider>
      </body>
    </html>
  );
}
