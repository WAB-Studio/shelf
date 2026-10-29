import { createHash } from "node:crypto";

// Salted so the caller's IP or the address itself is never stored.
function hashed(value: string, salt: string): string {
  return createHash("sha256").update(`${salt}:${value}`).digest("hex");
}

// First forwarded hop, else the real IP; null when the request names neither.
export function callerKey(headers: Headers, salt: string): string | null {
  const forwardedFor = headers.get("x-forwarded-for");
  const address = forwardedFor?.split(",")[0]?.trim() || headers.get("x-real-ip")?.trim();
  if (!address) return null;
  return `signin:${hashed(address, salt)}`;
}

// Keys the recipient, not the caller: case and spaces never split one.
export function addressKey(address: string, salt: string): string {
  return `signin-to:${hashed(address.trim().toLowerCase(), salt)}`;
}
