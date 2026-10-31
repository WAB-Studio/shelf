import { hasLocale, NextIntlClientProvider } from "next-intl";
import { getTranslations } from "next-intl/server";
import type { Metadata, Viewport } from "next";
import { Bricolage_Grotesque, Figtree, Geist_Mono } from "next/font/google";
import { notFound } from "next/navigation";

import { ThemeScript } from "@/components/theme-script";
import { AppTheme, Flex, Toaster } from "@/components/ui";
import { routing } from "@/i18n/routing";
import "@radix-ui/themes/styles.css";
import "../theme.css";

// The text and its figures (DESIGN.md «Violeta y lima»).
const sans = Figtree({
  variable: "--font-sans",
  subsets: ["latin"],
});

// The titles: a grotesque with character, where the screen names itself.
const heading = Bricolage_Grotesque({
  variable: "--font-heading",
  subsets: ["latin"],
});

const geistMono = Geist_Mono({
  variable: "--font-geist-mono",
  subsets: ["latin"],
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
    { media: "(prefers-color-scheme: light)", color: "#ffffff" },
    { media: "(prefers-color-scheme: dark)", color: "#110c20" },
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
