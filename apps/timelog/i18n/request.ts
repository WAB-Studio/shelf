import type { Messages } from "next-intl";
import { getRequestConfig } from "next-intl/server";

// One locale and no routing: the interface is Spanish.
export default getRequestConfig(async () => {
  const [common] = await Promise.all([import("../messages/es/common.json")]);

  return { locale: "es", messages: { common: common.default } as unknown as Messages };
});
