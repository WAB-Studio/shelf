import type common from "./messages/es/common.json";
import type time from "./messages/es/time.json";

// An array leaf is read through `t.raw`; typed as one key so next-intl keeps the namespace.
type Leafed<T> = T extends readonly unknown[] ? string : T extends object ? { [K in keyof T]: Leafed<T[K]> } : T;

// The namespaces `i18n/request.ts` returns.
declare module "next-intl" {
  interface AppConfig {
    Locale: "es";
    Messages: {
      common: Leafed<typeof common>;
      time: Leafed<typeof time>;
    };
  }
}
