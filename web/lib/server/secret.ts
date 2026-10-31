import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";

/**
 * Encryption at rest for secrets stored in the hub DB (e.g. the Immich API key).
 * AES-256-GCM; key from ORBIT_SECRET_KEY (64 hex chars or base64 of 32 bytes), otherwise a random key
 * generated once into <ORBIT_DATA_DIR>/secret.key (mode 600). Values never leave the server and are never logged.
 */
const PREFIX = "enc:v1:";
const g = globalThis as unknown as { __orbitSecretKey?: Buffer };

function loadKey(): Buffer {
  if (g.__orbitSecretKey) return g.__orbitSecretKey;
  const env = process.env.ORBIT_SECRET_KEY?.trim();
  let key: Buffer | null = null;
  if (env) {
    key = /^[0-9a-f]{64}$/i.test(env) ? Buffer.from(env, "hex") : Buffer.from(env, "base64");
    if (key.length !== 32) throw new Error("ORBIT_SECRET_KEY must be 32 bytes (64 hex chars or base64)");
  } else {
    const dir = path.resolve(/*turbopackIgnore: true*/ process.env.ORBIT_DATA_DIR ?? "./.data");
    const file = path.join(dir, "secret.key");
    if (existsSync(file)) key = Buffer.from(readFileSync(file, "utf8").trim(), "hex");
    if (!key || key.length !== 32) {
      mkdirSync(dir, { recursive: true });
      key = randomBytes(32);
      writeFileSync(file, key.toString("hex"), { mode: 0o600 });
      try {
        chmodSync(file, 0o600);
      } catch {
        /* Windows */
      }
    }
  }
  return (g.__orbitSecretKey = key);
}

export const isEncrypted = (v: string | null | undefined): boolean => !!v && v.startsWith(PREFIX);

export function encryptSecret(plain: string): string {
  const iv = randomBytes(12);
  const c = createCipheriv("aes-256-gcm", loadKey(), iv);
  const ct = Buffer.concat([c.update(plain, "utf8"), c.final()]);
  return `${PREFIX}${iv.toString("base64")}:${c.getAuthTag().toString("base64")}:${ct.toString("base64")}`;
}

/** Returns null when the value cannot be decrypted (e.g. the key file was replaced). */
export function decryptSecret(stored: string | null | undefined): string | null {
  if (!stored) return null;
  if (!isEncrypted(stored)) return stored; // legacy plain value
  try {
    const [iv, tag, ct] = stored.slice(PREFIX.length).split(":").map((p) => Buffer.from(p, "base64"));
    const d = createDecipheriv("aes-256-gcm", loadKey(), iv);
    d.setAuthTag(tag);
    return Buffer.concat([d.update(ct), d.final()]).toString("utf8");
  } catch {
    return null;
  }
}
