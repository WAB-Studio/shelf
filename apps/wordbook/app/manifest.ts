import type { MetadataRoute } from "next";
import { getTranslations } from "next-intl/server";

// The link tag in <head> is emitted from this file alone; iOS reads none of it
// (RootLayout's `appleWebApp` metadata covers iOS instead) but every other
// platform that offers "add to home screen" reads this.
export default async function manifest(): Promise<MetadataRoute.Manifest> {
  const t = await getTranslations("metadata");

  return {
    name: t("title"),
    short_name: t("shortTitle"),
    description: t("description"),
    start_url: "/",
    display: "standalone",
    // Matches app/theme.css: dark is the primary look (docs/voyager/DESIGN.md
    // "Tokens"), so the launch splash and the status bar read the same warm
    // near-black ground and terracotta accent as the app itself.
    background_color: "#14130f",
    theme_color: "#d9805f",
    lang: "es",
    icons: [
      {
        src: "/icon.svg",
        sizes: "any",
        type: "image/svg+xml",
      },
    ],
  };
}
