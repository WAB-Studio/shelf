import type common from "./messages/es/common.json";

// The namespaces `i18n/request.ts` returns.
declare module "next-intl" {
  interface AppConfig {
    Locale: "es";
    Messages: {
      common: typeof common;
    };
  }
}
