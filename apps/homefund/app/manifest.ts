import { getTranslations } from "next-intl/server";
import type { MetadataRoute } from "next";

import { DEFAULT_LOCALE } from "@/lib/locales";

/**
 * What makes the app installable (RNF-08). One manifest serves both languages:
 * it is fetched once at install time from the origin root, where no locale
 * segment exists, so its name reads from the default catalogue. `start_url` stays
 * "/" and the proxy negotiates the language on launch exactly as it does for any
 * other visit, which is what keeps the installed app on the person's own locale.
 *
 * The colours are the ones the interface already paints with: the warm off-white
 * `theme.css` writes over Radix's background, and the accent green of the mark.
 */
export default async function manifest(): Promise<MetadataRoute.Manifest> {
  const [common, metadata] = await Promise.all([
    getTranslations({ locale: DEFAULT_LOCALE, namespace: "common" }),
    getTranslations({ locale: DEFAULT_LOCALE, namespace: "metadata" }),
  ]);

  return {
    name: common("appName"),
    // Short enough for a launcher to write under the icon without truncating.
    short_name: common("appName"),
    description: metadata("description"),
    lang: DEFAULT_LOCALE,
    start_url: "/",
    scope: "/",
    display: "standalone",
    background_color: "#f5f3ef",
    theme_color: "#1e7a6a",
    icons: [
      { src: "/icons/icon.svg", sizes: "any", type: "image/svg+xml" },
      { src: "/icons/icon-192.png", sizes: "192x192", type: "image/png" },
      { src: "/icons/icon-512.png", sizes: "512x512", type: "image/png" },
      {
        src: "/icons/icon-maskable-512.png",
        sizes: "512x512",
        type: "image/png",
        purpose: "maskable",
      },
    ],
  };
}
