import { createHash } from "node:crypto";

// What a stored secret or address is kept as: the SHA-256 of it in hex, so the plaintext is never stored.
export function sha256Hex(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}
