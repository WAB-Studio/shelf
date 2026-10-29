import type { Messages } from "next-intl";
import { getRequestConfig } from "next-intl/server";

// One locale and no routing: the interface is Spanish.
export default getRequestConfig(async () => {
  const [common, time] = await Promise.all([import("../messages/es/common.json"), import("../messages/es/time.json")]);

  return { locale: "es", messages: { common: common.default, time: time.default } as unknown as Messages };
});
