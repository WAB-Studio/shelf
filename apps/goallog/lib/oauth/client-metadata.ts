import { lookup } from "node:dns/promises";
import { request } from "node:https";
import { isIP } from "node:net";

import { ipv6Bytes } from "@/lib/net/ipv6";
import { registrationSchema } from "@/lib/oauth/clients";

const MAX_BYTES = 64 * 1024;
const TIMEOUT_MS = 5000;

export type MetadataClient = { id: string; name: string; redirectUris: string[] };

export type MetadataDeps = {
  request?: typeof request;
  resolve?: (host: string) => Promise<string[]>;
  register?: (input: { name: string; redirectUris: string[]; metadataUrl: string }) => Promise<string>;
  timeoutMs?: number;
  // Counts one registration against the caller's address; the default claims the `register` bucket.
  claim?: (headers: CallerHeaders) => Promise<boolean>;
  // Reads a client already registered under the URL; it spends nothing.
  lookup?: (url: string) => Promise<MetadataClient | null>;
};

export type CallerHeaders = { get(name: string): string | null };

async function claimRegistration(headers: CallerHeaders): Promise<boolean> {
  const { callerAddress, claimCall } = await import("@/lib/oauth/throttle");

  return (await claimCall("register", callerAddress({ headers }))).ok;
}

async function storedClient(url: string): Promise<MetadataClient | null> {
  const { clientByMetadataUrl } = await import("@/lib/oauth/throttle");

  return clientByMetadataUrl(url);
}

function privateV4(address: string): boolean {
  const [a, b, c] = address.split(".").map(Number);
  return (
    a === 0 ||
    a === 10 ||
    a === 127 ||
    a >= 224 ||
    (a === 100 && b >= 64 && b <= 127) ||
    (a === 169 && b === 254) ||
    (a === 172 && b >= 16 && b <= 31) ||
    (a === 192 && b === 168) ||
    (a === 192 && b === 0 && c === 0) ||
    (a === 198 && (b === 18 || b === 19))
  );
}

export function privateAddress(address: string): boolean {
  const kind = isIP(address);
  if (kind === 4) return privateV4(address);
  if (kind !== 6) return true;

  const bytes = ipv6Bytes(address);
  if (!bytes) return true;
  const v4 = (at: number) => bytes.slice(at, at + 4).join(".");
  const zeros = (to: number) => bytes.slice(0, to).every((byte) => byte === 0);

  // ::ffff:0:0/96 mapped and ::/96 compatible.
  if (zeros(10) && bytes[10] === 0xff && bytes[11] === 0xff) return privateV4(v4(12));
  if (zeros(12)) return privateV4(v4(12));
  // 64:ff9b::/96 NAT64.
  if (bytes[0] === 0 && bytes[1] === 0x64 && bytes[2] === 0xff && bytes[3] === 0x9b && bytes.slice(4, 12).every((byte) => byte === 0)) {
    return privateV4(v4(12));
  }
  // 2002::/16 6to4.
  if (bytes[0] === 0x20 && bytes[1] === 0x02) return privateV4(v4(2));
  // fc00::/7 unique-local, fe80::/10 link-local, ff00::/8 multicast.
  return (bytes[0] & 0xfe) === 0xfc || (bytes[0] === 0xfe && (bytes[1] & 0xc0) === 0x80) || bytes[0] === 0xff;
}

async function resolveAll(host: string): Promise<string[]> {
  const rows = await lookup(host, { all: true });
  return rows.map((row) => row.address);
}

async function defaultRegister(input: { name: string; redirectUris: string[]; metadataUrl: string }) {
  const { registerClient } = await import("@/lib/oauth/grants");
  return registerClient(input);
}

// The socket connects to `address`, the one already validated; TLS and Host still carry the URL's name.
function fetchDocument(url: string, address: string, deps: MetadataDeps): Promise<unknown> {
  const host = new URL(url).hostname;
  const family = isIP(address);

  return new Promise<unknown>((resolve) => {
    let done = false;
    const timer = setTimeout(() => {
      req.destroy();
      finish(null);
    }, deps.timeoutMs ?? TIMEOUT_MS);
    const finish = (value: unknown) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      resolve(value);
    };
    const req = (deps.request ?? request)(
      url,
      {
        method: "GET",
        headers: { accept: "application/json" },
        servername: isIP(host) ? undefined : host,
        lookup: ((_host: string, options: { all?: boolean }, callback: (...args: unknown[]) => void) => {
          if (options?.all) callback(null, [{ address, family }]);
          else callback(null, address, family);
        }) as never,
      },
      (res) => {
        const type = String(res.headers["content-type"] ?? "").split(";")[0].trim().toLowerCase();
        const declared = Number(res.headers["content-length"]);
        if (res.statusCode !== 200 || type !== "application/json" || (Number.isFinite(declared) && declared > MAX_BYTES)) {
          res.destroy();
          return finish(null);
        }
        const chunks: Buffer[] = [];
        let total = 0;
        res.on("data", (chunk: Buffer) => {
          total += chunk.length;
          if (total > MAX_BYTES) {
            res.destroy();
            return finish(null);
          }
          chunks.push(chunk);
        });
        res.on("end", () => {
          try {
            finish(JSON.parse(Buffer.concat(chunks).toString("utf8")));
          } catch {
            finish(null);
          }
        });
        res.on("error", () => finish(null));
      },
    );
    req.on("error", () => finish(null));
    req.end();
  });
}

/**
 * Reads a client's metadata document and registers it. The fetch and the row it
 * buys share the registration limit (RNP-19), counted here so every caller —
 * the token route, the consent act, the consent page — is bound by it. A refused
 * claim reads as an unknown client. `caller` is the request's headers.
 * A URL already registered is read back without the fetch or the claim, when
 * `want` is absent or its redirect is among the stored ones.
 */
export async function clientFromMetadataUrl(
  url: string,
  caller: CallerHeaders,
  deps: MetadataDeps = {},
  want?: { redirectUri: string },
): Promise<MetadataClient | null> {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return null;
  }
  if (parsed.protocol !== "https:" || parsed.username || parsed.password || parsed.hash) return null;
  if (parsed.pathname === "/" || parsed.href !== url) return null;

  const stored = await (deps.lookup ?? storedClient)(url);
  if (stored && (!want || stored.redirectUris.includes(want.redirectUri))) return stored;

  const host = parsed.hostname.replace(/^\[|\]$/g, "");
  let addresses: string[];
  try {
    addresses = isIP(host) ? [host] : await (deps.resolve ?? resolveAll)(host);
  } catch {
    return null;
  }
  if (addresses.length === 0 || addresses.some(privateAddress)) return null;

  if (!(await (deps.claim ?? claimRegistration)(caller))) return null;

  const document = await fetchDocument(url, addresses[0], deps);
  if (typeof document !== "object" || document === null) return null;
  if ((document as { client_id?: unknown }).client_id !== url) return null;
  const fields = registrationSchema.safeParse(document);
  if (!fields.success) return null;

  const name = fields.data.client_name;
  const redirectUris = fields.data.redirect_uris;
  const id = await (deps.register ?? defaultRegister)({ name, redirectUris, metadataUrl: url });

  return { id, name, redirectUris };
}
