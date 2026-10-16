/** The four headers every public OAuth response carries; no credentials are ever allowed. */
export function cors(methods: "GET" | "POST") {
  return {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Methods": `${methods}, OPTIONS`,
    "Access-Control-Allow-Headers": "*",
    "Access-Control-Max-Age": "86400",
  };
}
