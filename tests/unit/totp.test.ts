import { describe, expect, it } from "vitest";
import { base32Decode, base32Encode, otpauthUri, totpCode, totpStep, verifyTotp } from "@/server/auth/totp";

// Vetores do RFC 6238 (apêndice B), HMAC-SHA1, semente ASCII "12345678901234567890".
const RFC_SECRET = base32Encode(Buffer.from("12345678901234567890"));
const at = (unixSeconds: number) => new Date(unixSeconds * 1000);

describe("TOTP (RFC 6238)", () => {
  it.each([
    [59, "94287082"],
    [1111111109, "07081804"],
    [1111111111, "14050471"],
    [1234567890, "89005924"],
    [2000000000, "69279037"],
    [20000000000, "65353130"],
  ])("t=%i → %s (8 dígitos)", (t, expected) => {
    expect(totpCode(RFC_SECRET, totpStep(at(t)), 8)).toBe(expected);
  });

  it("base32 ida e volta, tolerante a espaços e minúsculas", () => {
    const buf = Buffer.from("segredo-qualquer-123");
    expect(base32Decode(base32Encode(buf))).toEqual(buf);
    expect(base32Decode(base32Encode(buf).toLowerCase().replace(/(.{4})/g, "$1 "))).toEqual(buf);
    expect(() => base32Decode("1!")).toThrow();
  });

  it("aceita o passo atual e ±1 (relógio do celular adiantado/atrasado), recusa ±2", () => {
    const now = at(1_700_000_000);
    const step = totpStep(now);
    expect(verifyTotp(RFC_SECRET, totpCode(RFC_SECRET, step), now)).toBe(step);
    expect(verifyTotp(RFC_SECRET, totpCode(RFC_SECRET, step - 1), now)).toBe(step - 1);
    expect(verifyTotp(RFC_SECRET, totpCode(RFC_SECRET, step + 1), now)).toBe(step + 1);
    expect(verifyTotp(RFC_SECRET, totpCode(RFC_SECRET, step - 2), now)).toBeNull();
    expect(verifyTotp(RFC_SECRET, totpCode(RFC_SECRET, step + 2), now)).toBeNull();
  });

  it("não aceita de novo um passo já usado nem anterior a ele", () => {
    const now = at(1_700_000_000);
    const step = totpStep(now);
    expect(verifyTotp(RFC_SECRET, totpCode(RFC_SECRET, step), now, step)).toBeNull();
    expect(verifyTotp(RFC_SECRET, totpCode(RFC_SECRET, step - 1), now, step - 1)).toBeNull();
    expect(verifyTotp(RFC_SECRET, totpCode(RFC_SECRET, step + 1), now, step)).toBe(step + 1);
  });

  it("formato do código: só 6 dígitos (espaço no meio tolerado)", () => {
    const now = at(1_700_000_000);
    const code = totpCode(RFC_SECRET, totpStep(now));
    expect(verifyTotp(RFC_SECRET, `${code.slice(0, 3)} ${code.slice(3)}`, now)).not.toBeNull();
    expect(verifyTotp(RFC_SECRET, "12345", now)).toBeNull();
    expect(verifyTotp(RFC_SECRET, "abcdef", now)).toBeNull();
  });

  it("URI otpauth com emissor e conta", () => {
    const uri = otpauthUri("JBSWY3DPEHPK3PXP", "ana@exemplo.com.br");
    expect(uri).toBe("otpauth://totp/QQPega%3Aana%40exemplo.com.br?secret=JBSWY3DPEHPK3PXP&issuer=QQPega&algorithm=SHA1&digits=6&period=30");
  });
});
