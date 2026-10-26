import "server-only";
import { createCipheriv, createDecipheriv, createHash, createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import { env } from "./env";

export const randomToken = (bytes = 32) => randomBytes(bytes).toString("base64url");

/** HMAC-SHA256 com AUTH_SECRET — usado para guardar tokens sem o valor em claro. */
export function hashToken(token: string): string {
  return createHmac("sha256", env().AUTH_SECRET).update(token).digest("hex");
}

export function safeEqual(a: string, b: string): boolean {
  const ba = Buffer.from(a);
  const bb = Buffer.from(b);
  return ba.length === bb.length && timingSafeEqual(ba, bb);
}

const CROCKFORD = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";
/** Código legível e não sequencial (base32 Crockford). */
export function randomCode(length = 10): string {
  const bytes = randomBytes(length);
  let out = "";
  for (let i = 0; i < length; i++) out += CROCKFORD[bytes[i] & 31];
  return out;
}

function encryptionKey(): Buffer {
  const raw = env().DATA_ENCRYPTION_KEY;
  const decoded = Buffer.from(raw, "base64");
  if (decoded.length === 32 && !raw.startsWith("dev-only")) return decoded;
  if (env().NODE_ENV === "production") throw new Error("DATA_ENCRYPTION_KEY deve ter 32 bytes em base64");
  return createHash("sha256").update(raw).digest();
}

/** AES-256-GCM. Formato: v1.<iv>.<tag>.<ciphertext> (base64url). */
export function encryptPII(plain: string): string {
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", encryptionKey(), iv);
  const ct = Buffer.concat([cipher.update(plain, "utf8"), cipher.final()]);
  return ["v1", iv.toString("base64url"), cipher.getAuthTag().toString("base64url"), ct.toString("base64url")].join(".");
}

export function decryptPII(payload: string): string {
  const [v, iv, tag, ct] = payload.split(".");
  if (v !== "v1") throw new Error("Formato de dado cifrado desconhecido");
  const decipher = createDecipheriv("aes-256-gcm", encryptionKey(), Buffer.from(iv, "base64url"));
  decipher.setAuthTag(Buffer.from(tag, "base64url"));
  return Buffer.concat([decipher.update(Buffer.from(ct, "base64url")), decipher.final()]).toString("utf8");
}
