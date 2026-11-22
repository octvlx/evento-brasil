import "server-only";
import { createCipheriv, createDecipheriv, createECDH, createHash, createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import { env } from "./env";

export const randomToken = (bytes = 32) => randomBytes(bytes).toString("base64url");

/** HMAC-SHA256 com AUTH_SECRET — usado para guardar tokens sem o valor em claro. */
export function hashToken(token: string): string {
  return createHmac("sha256", env().AUTH_SECRET).update(token).digest("hex");
}

/** SHA-256 (hex) do token do QR: o que o banco e a lista offline guardam. */
export const qrTokenHash = (token: string) => createHash("sha256").update(token).digest("hex");

/**
 * Token do QR de um ingresso: HMAC(QR_TOKEN_SECRET, código, versão), 43 caracteres
 * base64url. Não é guardado; quem tem só o banco não consegue montar QRs.
 */
export function deriveQrToken(code: string, version: number): string {
  return createHmac("sha256", env().QR_TOKEN_SECRET).update(`eb-qr:${code}:${version}`).digest("base64url");
}

/** Ordem da curva P-256: a chave privada precisa estar em [1, n). */
const P256_N = BigInt("0xffffffff00000000ffffffffffffffffbce6faada7179e84f3b9cac2fc632551");

/**
 * Chave de assinatura do QR dinâmico de um ingresso (ECDSA P-256), derivada de
 * QR_TOKEN_SECRET + código + versão: nada é guardado no banco, e trocar a versão (ex.:
 * transferência aceita) troca a chave. `d` vai só para o celular do titular; `x`/`y`
 * (pública) vão para a portaria e não permitem gerar QR.
 */
export function deriveTicketSigningKey(code: string, version: number): { d: string; x: string; y: string } {
  for (let attempt = 0; ; attempt++) {
    const d = createHmac("sha256", env().QR_TOKEN_SECRET).update(`eb-qr-key:${code}:${version}:${attempt}`).digest();
    const n = BigInt(`0x${d.toString("hex")}`);
    if (n === BigInt(0) || n >= P256_N) continue; // probabilidade ~2^-32
    const ecdh = createECDH("prime256v1");
    ecdh.setPrivateKey(d);
    const pub = ecdh.getPublicKey(); // 0x04 ‖ x ‖ y
    return { d: d.toString("base64url"), x: pub.subarray(1, 33).toString("base64url"), y: pub.subarray(33, 65).toString("base64url") };
  }
}

/**
 * Segredo TOTP do QR rotativo do Google Wallet de um ingresso (20 bytes, como no RFC 6238).
 * Derivado de QR_TOKEN_SECRET + código + versão: vai para o Google no objeto do passe e é
 * recalculado na portaria (online). A transferência troca a versão e, com ela, o segredo.
 */
export function deriveWalletTotpKey(code: string, version: number): Buffer {
  return createHmac("sha256", env().QR_TOKEN_SECRET).update(`eb-gw-totp:${code}:${version}`).digest().subarray(0, 20);
}

/** TOTP/HOTP (RFC 4226/6238) com HMAC-SHA1 para o contador `counter`. */
export function totpCode(key: Buffer, counter: number, digits: number): string {
  const msg = Buffer.alloc(8);
  msg.writeBigUInt64BE(BigInt(counter));
  const mac = createHmac("sha1", key).update(msg).digest();
  const offset = mac[mac.length - 1] & 0x0f;
  const bin = ((mac[offset] & 0x7f) << 24) | (mac[offset + 1] << 16) | (mac[offset + 2] << 8) | mac[offset + 3];
  return String(bin % 10 ** digits).padStart(digits, "0");
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
