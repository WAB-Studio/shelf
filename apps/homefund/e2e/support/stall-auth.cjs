// Preloaded (`NODE_OPTIONS=--require`) into a second `next start` of the lane's own build, so the
// route under test runs unchanged. A verify call whose body names a stall token never reaches Auth:
// `stall-504` is answered the way a gateway that gave up answers, `stall-refused` the way a
// connection that was refused fails. Every other call goes to the real stack.
const realFetch = globalThis.fetch;

globalThis.fetch = async (input, init) => {
  const url = typeof input === "string" ? input : (input.url ?? String(input));
  if (url.includes("/auth/v1/verify")) {
    const body = typeof init?.body === "string" ? init.body : "";
    if (body.includes("stall-refused")) throw new TypeError("fetch failed");
    if (body.includes("stall-504")) return new Response("", { status: 504 });
  }
  return realFetch(input, init);
};
