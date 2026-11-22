// Formato do QR do ingresso, usado no servidor (check-in online), no aparelho da portaria
// (check-in offline) e no celular do titular (que gera o QR dinâmico). Sem segredos aqui.
//
// EB1 (fixo): `EB1:<código>:<token>`. Ia no PDF e na carteira; um print valia para sempre.
// EB2 (dinâmico): `EB2:<código>:<passo>:<assinatura>`. O celular do titular assina
// `eb2:<código>:<passo>` com a chave do ingresso (ECDSA P-256) e troca o QR a cada passo
// de QR_STEP_MS; a portaria confere com a chave PÚBLICA e aceita só passos próximos do
// atual. Um print vence em segundos, e a lista offline da portaria não permite forjar QR.

export const QR_PREFIX = "EB1";
export const DYNAMIC_QR_PREFIX = "EB2";

/** Duração de cada QR dinâmico. */
export const QR_STEP_MS = 30_000;
/** Passos aceitos antes/depois do atual (atraso de leitura e relógios um pouco diferentes). */
export const QR_STEP_TOLERANCE = 2;

const CODE = "[0-9A-HJKMNP-TV-Z]{10}";

export function qrPayload(ticket: { code: string; validationToken: string }): string {
  return `${QR_PREFIX}:${ticket.code}:${ticket.validationToken}`;
}

export function parseQrPayload(raw: string): { code: string; token: string } | null {
  const m = new RegExp(`^EB1:(${CODE}):([A-Za-z0-9_-]{43})$`).exec(raw.trim());
  return m ? { code: m[1], token: m[2] } : null;
}

export const qrStep = (atMs: number) => Math.floor(atMs / QR_STEP_MS);

/** Texto assinado no QR dinâmico. */
export const dynamicQrMessage = (code: string, step: number) => `eb2:${code}:${step}`;

export function dynamicQrPayload(code: string, step: number, signature: string): string {
  return `${DYNAMIC_QR_PREFIX}:${code}:${step}:${signature}`;
}

/** Assinatura ECDSA P-256 em IEEE P1363 (r‖s, 64 bytes) = 86 caracteres base64url. */
export function parseDynamicQrPayload(raw: string): { code: string; step: number; signature: string } | null {
  const m = new RegExp(`^EB2:(${CODE}):(\\d{1,12}):([A-Za-z0-9_-]{86})$`).exec(raw.trim());
  return m ? { code: m[1], step: Number(m[2]), signature: m[3] } : null;
}

/** O passo do QR está dentro da tolerância em relação a `nowMs`? */
export const qrStepFresh = (step: number, nowMs: number) => Math.abs(step - qrStep(nowMs)) <= QR_STEP_TOLERANCE;

export function base64urlToBytes(s: string): Uint8Array<ArrayBuffer> {
  const b64 = s.replace(/-/g, "+").replace(/_/g, "/") + "===".slice((s.length + 3) % 4);
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

export function bytesToBase64url(bytes: ArrayBuffer | Uint8Array): string {
  const arr = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  let bin = "";
  for (const b of arr) bin += String.fromCharCode(b);
  return btoa(bin).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

/** Chave pública do ingresso (JWK P-256 sem `d`), como vai na lista offline. */
export interface TicketPublicKey {
  x: string;
  y: string;
}

/** Confere a assinatura do QR dinâmico com WebCrypto (navegador ou Node). */
export async function verifyDynamicQrSignature(key: TicketPublicKey, code: string, step: number, signature: string): Promise<boolean> {
  try {
    const pub = await crypto.subtle.importKey("jwk", { kty: "EC", crv: "P-256", x: key.x, y: key.y, ext: true }, { name: "ECDSA", namedCurve: "P-256" }, false, ["verify"]);
    return await crypto.subtle.verify({ name: "ECDSA", hash: "SHA-256" }, pub, base64urlToBytes(signature), new TextEncoder().encode(dynamicQrMessage(code, step)));
  } catch {
    return false;
  }
}

// EB3 (Google Wallet, QR rotativo): `EB3:<código>:<segundos>:<TOTP>`. O Google gera o código
// dentro do passe (TOTP RFC 6238, SHA-1, 8 dígitos, período QR_STEP_MS) a partir de um segredo
// por ingresso que só o servidor e o Google conhecem. Por isso a portaria valida EB3 só online.
export const WALLET_QR_PREFIX = "EB3";
export const WALLET_TOTP_DIGITS = 8;

export function parseWalletQrPayload(raw: string): { code: string; step: number; totp: string } | null {
  const m = new RegExp(`^EB3:(${CODE}):(\\d{9,11}):(\\d{${WALLET_TOTP_DIGITS}})$`).exec(raw.trim());
  return m ? { code: m[1], step: qrStep(Number(m[2]) * 1000), totp: m[3] } : null;
}
