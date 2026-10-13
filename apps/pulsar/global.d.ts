import type common from "./messages/es/common.json";
import type account from "./messages/es/account.json";
import type day from "./messages/es/day.json";
import type goal from "./messages/es/goal.json";
import type plan from "./messages/es/plan.json";
import type week from "./messages/es/week.json";
import type sources from "./messages/es/sources.json";
import type oneOffs from "./messages/es/oneOffs.json";
import type month from "./messages/es/month.json";
import type exportMessages from "./messages/es/export.json";
import type units from "./messages/es/units.json";
import type importMessages from "./messages/es/import.json";
import type connections from "./messages/es/connections.json";
import type oauth from "./messages/es/oauth.json";
import type roadmap from "./messages/es/roadmap.json";
import type tree from "./messages/es/tree.json";
import type chat from "./messages/es/chat.json";

// next-intl walks an array's methods as if they were keys and gives up on the
// whole namespace; an array leaf is read through `t.raw`, so it stands as one key.
// Known hole: an array key typechecks under `t()` too, though only `t.raw` reads it.
type Leafed<T> = T extends readonly unknown[] ? string : T extends object ? { [K in keyof T]: Leafed<T[K]> } : T;

// Same seventeen namespaces `i18n/request.ts` returns; `mcp.json` is read
// directly by lib/mcp and never through `t`.
declare module "next-intl" {
  interface AppConfig {
    Locale: "es";
    Messages: {
      common: Leafed<typeof common>;
      account: Leafed<typeof account>;
      day: Leafed<typeof day>;
      goal: Leafed<typeof goal>;
      plan: Leafed<typeof plan>;
      week: Leafed<typeof week>;
      sources: Leafed<typeof sources>;
      oneOffs: Leafed<typeof oneOffs>;
      month: Leafed<typeof month>;
      export: Leafed<typeof exportMessages>;
      units: Leafed<typeof units>;
      import: Leafed<typeof importMessages>;
      connections: Leafed<typeof connections>;
      oauth: Leafed<typeof oauth>;
      roadmap: Leafed<typeof roadmap>;
      tree: Leafed<typeof tree>;
      chat: Leafed<typeof chat>;
    };
  }
}
