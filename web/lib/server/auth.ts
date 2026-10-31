import { createHmac, timingSafeEqual } from "node:crypto";

export const AUTH_COOKIE = "orbit_auth";

/** Cookie value = HMAC-SHA256(key = password, msg = fixed string), hex. */
export const authToken = (password: string) => createHmac("sha256", password).update("orbit-auth-v1").digest("hex");

export function safeEqual(a: string, b: string): boolean {
  const x = Buffer.from(a);
  const y = Buffer.from(b);
  return x.length === y.length && timingSafeEqual(x, y);
}
