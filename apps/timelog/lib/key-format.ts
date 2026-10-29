import { createHash, randomBytes } from "node:crypto";

const KEY_PREFIX = "tl_";

export function fingerprint(secret: string): Buffer {
  return createHash("sha256").update(secret).digest();
}

// 32 random bytes need no pepper: the digest of a 256-bit value cannot be walked back.
export function mintKey(): { key: string; hash: Buffer; hint: string } {
  const key = KEY_PREFIX + randomBytes(32).toString("base64url");

  return { key, hash: fingerprint(key), hint: key.slice(-4) };
}

// The bearer of `Authorization: Bearer tl_…`, or null for any other header.
export function bearerOf(header: string | null): string | null {
  const match = /^Bearer (tl_[A-Za-z0-9_-]{43})$/.exec(header ?? "");
  return match ? match[1] : null;
}
