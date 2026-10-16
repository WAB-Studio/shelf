import { getRequestConfig } from "next-intl/server";

// One locale and no routing: the interface is Spanish (RNL-02), no segment
// carries it and nothing negotiates it.
export default getRequestConfig(async () => ({
  locale: "es",
  messages: (await import("../messages/es.json")).default,
}));
