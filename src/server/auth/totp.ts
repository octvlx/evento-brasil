import "server-only";
import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";

// TOTP (RFC 6238) com HMAC-SHA1, 6 dígitos e passo de 30 s: o formato que os
// aplicativos autenticadores (Google Authenticator, Microsoft Authenticator,
// 1Password, Authy...) leem pelo QR otpauth://. Implementado com node:crypto,
// sem dependência nova.

export const TOTP_PERIOD_SECONDS = 30;
export const TOTP_DIGITS = 6;
/** Passos aceitos antes e depois do atual: tolera ±30 s de diferença de relógio. */
export const TOTP_WINDOW = 1;
export const TOTP_ISSUER = "Evento Brasil";

const BASE32 = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";

export function base32Encode(buf: Buffer): string {
  let bits = 0;
  let value = 0;
  let out = "";
  for (const byte of buf) {
    value = (value << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      out += BASE32[(value >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }
  if (bits > 0) out += BASE32[(value << (5 - bits)) & 31];
  return out;
}

export function base32Decode(input: string): Buffer {
  const clean = input.toUpperCase().replace(/[\s=-]/g, "");
  let bits = 0;
  let value = 0;
  const out: number[] = [];
  for (const ch of clean) {
    const idx = BASE32.indexOf(ch);
    if (idx < 0) throw new RangeError("Segredo base32 inválido");
    value = (value << 5) | idx;
    bits += 5;
    if (bits >= 8) {
      out.push((value >>> (bits - 8)) & 255);
      bits -= 8;
    }
  }
  return Buffer.from(out);
}

/** Segredo novo de 160 bits (tamanho recomendado para HMAC-SHA1), em base32. */
export function generateTotpSecret(): string {
  return base32Encode(randomBytes(20));
}

export function totpStep(now: Date): number {
  return Math.floor(now.getTime() / 1000 / TOTP_PERIOD_SECONDS);
}

/** Código do passo informado (HOTP do RFC 4226 com contador = passo). */
export function totpCode(secretBase32: string, step: number, digits = TOTP_DIGITS): string {
  const counter = Buffer.alloc(8);
  counter.writeBigUInt64BE(BigInt(step));
  const mac = createHmac("sha1", base32Decode(secretBase32)).update(counter).digest();
  const offset = mac[mac.length - 1] & 0x0f;
  const binary = (mac.readUInt32BE(offset) & 0x7fffffff) % 10 ** digits;
  return binary.toString().padStart(digits, "0");
}

/**
 * Confere o código na janela de ±TOTP_WINDOW passos. Devolve o passo aceito,
 * ou null. Passos até `lastUsedStep` (inclusive) são recusados: um código já
 * usado não serve de novo, nem um anterior a ele.
 */
export function verifyTotp(secretBase32: string, code: string, now: Date, lastUsedStep?: number | null): number | null {
  const digits = code.replace(/\s/g, "");
  if (!/^\d{6}$/.test(digits)) return null;
  const current = totpStep(now);
  for (let delta = -TOTP_WINDOW; delta <= TOTP_WINDOW; delta++) {
    const step = current + delta;
    if (lastUsedStep != null && step <= lastUsedStep) continue;
    if (timingSafeEqual(Buffer.from(totpCode(secretBase32, step)), Buffer.from(digits))) return step;
  }
  return null;
}

/** URI lida pelos aplicativos autenticadores (formato "Key Uri" do Google Authenticator). */
export function otpauthUri(secretBase32: string, accountEmail: string): string {
  const label = encodeURIComponent(`${TOTP_ISSUER}:${accountEmail}`);
  const params = new URLSearchParams({ secret: secretBase32, issuer: TOTP_ISSUER, algorithm: "SHA1", digits: String(TOTP_DIGITS), period: String(TOTP_PERIOD_SECONDS) });
  return `otpauth://totp/${label}?${params.toString()}`;
}
