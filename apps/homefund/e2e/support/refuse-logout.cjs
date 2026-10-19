// Preloaded (`NODE_OPTIONS=--require`) into a second `next start` of the lane's own build. Auth's
// logout call is answered with a 500, the way an Auth outage answers; every other call goes to the real stack.
const realFetch = globalThis.fetch;

globalThis.fetch = async (input, init) => {
  const url = typeof input === "string" ? input : (input.url ?? String(input));
  if (url.includes("/auth/v1/logout")) {
    return new Response(JSON.stringify({ message: "refused", code: "unexpected_failure" }), {
      status: 500,
      headers: { "content-type": "application/json" },
    });
  }
  return realFetch(input, init);
};
