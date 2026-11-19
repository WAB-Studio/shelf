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
    // Matches app/theme.css (docs/wordbook/DESIGN.md «Gris frío y azul»): the launch splash reads the
    // dark ground and the status bar the blue accent, as the app itself does.
    background_color: "#121418",
    theme_color: "#2d5ba8",
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
