import { describe, expect, it, vi } from "vitest";

vi.mock("@/server/env", () => ({ env: () => ({ QR_TOKEN_SECRET: "test-only-qr-secret-0123456789", GOOGLE_WALLET_ROTATING_QR: true }) }));

import { deriveWalletTotpKey, totpCode } from "@/server/crypto";
import { walletRotatingBarcode } from "@/server/tickets/wallet/google";
import { parseWalletQrPayload, qrStep } from "@/lib/qr-payload";

describe("TOTP do Google Wallet", () => {
  it("bate com o vetor de teste do RFC 6238 (SHA-1, 8 dígitos)", () => {
    const key = Buffer.from("12345678901234567890");
    expect(totpCode(key, Math.floor(59 / 30), 8)).toBe("94287082");
    expect(totpCode(key, Math.floor(1111111109 / 30), 8)).toBe("07081804");
    expect(totpCode(key, Math.floor(2000000000 / 30), 8)).toBe("69279037");
  });

  it("segredo por ingresso e versão, 20 bytes", () => {
    const a = deriveWalletTotpKey("ABCD1234EF", 1);
    expect(a).toHaveLength(20);
    expect(deriveWalletTotpKey("ABCD1234EF", 1)).toEqual(a);
    expect(deriveWalletTotpKey("ABCD1234EF", 2)).not.toEqual(a);
  });

  it("objeto do passe: padrão EB3 com timestamp e TOTP, período de 30 s e segredo em hex", () => {
    const b = walletRotatingBarcode("ABCD1234EF", 1);
    expect(b).toMatchObject({
      type: "QR_CODE",
      valuePattern: "EB3:ABCD1234EF:{totp_timestamp_seconds}:{totp_value_0}",
      totpDetails: { periodMillis: "30000", algorithm: "TOTP_SHA1", parameters: [{ key: deriveWalletTotpKey("ABCD1234EF", 1).toString("hex"), valueLength: 8 }] },
    });
  });

  it("lê o QR que o Google gera (passo pelo timestamp)", () => {
    const ts = 1_800_000_015;
    expect(parseWalletQrPayload(`EB3:ABCD1234EF:${ts}:12345678`)).toEqual({ code: "ABCD1234EF", step: qrStep(ts * 1000), totp: "12345678" });
    expect(parseWalletQrPayload("EB3:ABCD1234EF:1800000015:1234567")).toBeNull();
  });
});
