import type { Locale } from "./lib/locales";
import type es from "./messages/es.json";

declare module "next-intl" {
  interface AppConfig {
    Locale: Locale;
    Messages: typeof es;
  }
}
