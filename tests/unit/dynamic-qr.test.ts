import { createPrivateKey, sign } from "node:crypto";
import { describe, expect, it } from "vitest";
import { deriveTicketSigningKey } from "@/server/crypto";
import { ticketPublicKey, ticketSigningJwk } from "@/server/services/tickets";
import {
  bytesToBase64url,
  dynamicQrMessage,
  dynamicQrPayload,
  parseDynamicQrPayload,
  parseQrPayload,
  QR_STEP_MS,
  QR_STEP_TOLERANCE,
  qrStep,
  qrStepFresh,
  verifyDynamicQrSignature,
} from "@/lib/qr-payload";

const CODE = "ABCD1234EF";

function signNode(code: string, version: number, step: number) {
  const key = createPrivateKey({ key: ticketSigningJwk({ code, tokenVersion: version }), format: "jwk" });
  return sign("sha256", Buffer.from(dynamicQrMessage(code, step)), { key, dsaEncoding: "ieee-p1363" }).toString("base64url");
}

describe("QR dinâmico (EB2)", () => {
  it("chave derivada é determinística por código e versão; a versão nova troca a chave", () => {
    expect(deriveTicketSigningKey(CODE, 1)).toEqual(deriveTicketSigningKey(CODE, 1));
    expect(deriveTicketSigningKey(CODE, 2).x).not.toBe(deriveTicketSigningKey(CODE, 1).x);
    expect(ticketPublicKey({ code: CODE, tokenVersion: 1 })).not.toHaveProperty("d");
  });

  it("assinatura do celular (WebCrypto) confere com a chave pública; formato do QR ida e volta", async () => {
    const step = qrStep(Date.now());
    const key = await crypto.subtle.importKey("jwk", { ...ticketSigningJwk({ code: CODE, tokenVersion: 1 }), ext: false }, { name: "ECDSA", namedCurve: "P-256" }, false, ["sign"]);
    const sig = bytesToBase64url(await crypto.subtle.sign({ name: "ECDSA", hash: "SHA-256" }, key, new TextEncoder().encode(dynamicQrMessage(CODE, step))));
    const parsed = parseDynamicQrPayload(dynamicQrPayload(CODE, step, sig));
    expect(parsed).toEqual({ code: CODE, step, signature: sig });
    expect(await verifyDynamicQrSignature(ticketPublicKey({ code: CODE, tokenVersion: 1 }), CODE, step, sig)).toBe(true);
    // Mesma assinatura gerada no Node (helper dos testes) também confere.
    expect(await verifyDynamicQrSignature(ticketPublicKey({ code: CODE, tokenVersion: 1 }), CODE, step, signNode(CODE, 1, step))).toBe(true);
  });

  it("recusa: outro passo, outro código, outra versão da chave, assinatura adulterada", async () => {
    const step = 1000;
    const sig = signNode(CODE, 1, step);
    const pub = ticketPublicKey({ code: CODE, tokenVersion: 1 });
    expect(await verifyDynamicQrSignature(pub, CODE, step + 1, sig)).toBe(false);
    expect(await verifyDynamicQrSignature(pub, "ZZZZ1234EF", step, sig)).toBe(false);
    expect(await verifyDynamicQrSignature(ticketPublicKey({ code: CODE, tokenVersion: 2 }), CODE, step, sig)).toBe(false);
    expect(await verifyDynamicQrSignature(pub, CODE, step, `${sig.slice(0, -2)}AA`)).toBe(false);
  });

  it("validade do passo: atual ± tolerância", () => {
    const now = 1_800_000_000_000;
    const step = qrStep(now);
    expect(qrStepFresh(step, now)).toBe(true);
    expect(qrStepFresh(step - QR_STEP_TOLERANCE, now)).toBe(true);
    expect(qrStepFresh(step - QR_STEP_TOLERANCE - 1, now)).toBe(false);
    expect(qrStepFresh(step + QR_STEP_TOLERANCE + 1, now)).toBe(false);
    // Um print vale no máximo ~(tolerância + 1) passos.
    expect((QR_STEP_TOLERANCE + 1) * QR_STEP_MS).toBeLessThanOrEqual(90_000);
  });

  it("formatos: EB1 e EB2 não se confundem; lixo é recusado", () => {
    expect(parseDynamicQrPayload(`EB1:${CODE}:${"t".repeat(43)}`)).toBeNull();
    expect(parseQrPayload(`EB2:${CODE}:1:${"s".repeat(86)}`)).toBeNull();
    expect(parseDynamicQrPayload(`EB2:${CODE}:abc:${"s".repeat(86)}`)).toBeNull();
    expect(parseDynamicQrPayload(`EB2:${CODE}:1:${"s".repeat(85)}`)).toBeNull();
  });
});
