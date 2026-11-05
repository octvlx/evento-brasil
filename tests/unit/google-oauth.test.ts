import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { createLocalJWKSet, exportJWK, generateKeyPair, SignJWT } from "jose";
let google: typeof import("@/server/auth/google");
let keyPair: Awaited<ReturnType<typeof generateKeyPair>>;
let resolver: ReturnType<typeof createLocalJWKSet>;
beforeAll(async () => { keyPair = await generateKeyPair("RS256"); const jwk = await exportJWK(keyPair.publicKey); resolver = createLocalJWKSet({ keys: [{ ...jwk, kid: "test", alg: "RS256" }] }); });
beforeEach(async () => { vi.resetModules(); vi.stubEnv("GOOGLE_CLIENT_ID", "client-test"); vi.stubEnv("GOOGLE_CLIENT_SECRET", "not-real-secret"); google = await import("@/server/auth/google"); });
afterEach(() => { vi.unstubAllGlobals(); vi.unstubAllEnvs(); });
async function token(overrides: Record<string, unknown> = {}, issuer = "https://accounts.google.com", audience = "client-test", expires = Math.floor(Date.now()/1000) + 300) {
  return new SignJWT({ sub: "google-user-1", email: "person@example.com", name: "Pessoa Google", email_verified: true, nonce: "expected-nonce", ...overrides }).setProtectedHeader({ alg: "RS256", kid: "test" }).setIssuer(issuer).setAudience(audience).setIssuedAt().setExpirationTime(expires).sign(keyPair.privateKey);
}
describe("Google OpenID verification", () => {
  it("accepts a signed identity with correct audience, issuer, expiry and nonce", async () => {
    expect(await google.validateGoogleIdToken(await token(), "expected-nonce", "client-test", resolver)).toEqual({ subject: "google-user-1", email: "person@example.com", name: "Pessoa Google" });
  });
  it.each([
    { claims: { nonce: "wrong" } }, { claims: { email_verified: false } }, { claims: { azp: "wrong-client" } },
    { claims: {}, issuer: "https://attacker.example" }, { claims: {}, audience: "wrong-client" }, { claims: {}, expires: 1 },
  ])("rejects invalid OpenID claims %#", async ({ claims, issuer, audience, expires }) => {
    await expect(google.validateGoogleIdToken(await token(claims, issuer, audience, expires), "expected-nonce", "client-test", resolver)).rejects.toMatchObject({ code: "PROVIDER_ERROR" });
  });
  it("tolerates a server clock slightly behind Google (iat a few seconds in the future)", async () => {
    const now = Math.floor(Date.now() / 1000);
    const ahead = await new SignJWT({ sub: "google-user-1", email: "person@example.com", name: "Pessoa Google", email_verified: true, nonce: "expected-nonce" }).setProtectedHeader({ alg: "RS256", kid: "test" }).setIssuer("https://accounts.google.com").setAudience("client-test").setIssuedAt(now + 5).setExpirationTime(now + 300).sign(keyPair.privateKey);
    await expect(google.validateGoogleIdToken(ahead, "expected-nonce", "client-test", resolver)).resolves.toMatchObject({ subject: "google-user-1" });
    const farAhead = await new SignJWT({ sub: "google-user-1", email: "person@example.com", name: "Pessoa Google", email_verified: true, nonce: "expected-nonce" }).setProtectedHeader({ alg: "RS256", kid: "test" }).setIssuer("https://accounts.google.com").setAudience("client-test").setIssuedAt(now + 600).setExpirationTime(now + 900).sign(keyPair.privateKey);
    await expect(google.validateGoogleIdToken(farAhead, "expected-nonce", "client-test", resolver)).rejects.toMatchObject({ code: "PROVIDER_ERROR" });
  });
  it("rejects a modified JWT signature", async () => {
    const signed = await token(); const parts = signed.split("."); parts[2] = (parts[2][0] === "a" ? "b" : "a") + parts[2].slice(1);
    await expect(google.validateGoogleIdToken(parts.join("."), "expected-nonce", "client-test", resolver)).rejects.toMatchObject({ code: "PROVIDER_ERROR" });
  });
  it("binds state and PKCE to an encrypted expiring cookie and preserves only internal returns", async () => {
    const flow = google.beginGoogleLogin("/checkout/revisao/draft-1");
    const url = new URL(flow.url); expect(url.searchParams.get("code_challenge_method")).toBe("S256");
    const parsed = google.googleFlowSchema.parse(google.readGoogleCookie("flow", flow.cookie));
    expect(parsed.next).toBe("/checkout/revisao/draft-1"); expect(parsed.verifier).not.toBe(url.searchParams.get("code_challenge"));
    const fetch = vi.fn(); vi.stubGlobal("fetch", fetch);
    await expect(google.exchangeGoogleCode("code", "wrong-state", flow.cookie)).rejects.toMatchObject({ code: "PROVIDER_ERROR" });
    expect(fetch).not.toHaveBeenCalled();
    expect(() => google.readGoogleCookie("pending", flow.cookie)).toThrow();
    expect(() => google.readGoogleCookie("flow", flow.cookie + "tampered")).toThrow();
    const future = Date.now() + 11 * 60_000; vi.spyOn(Date, "now").mockReturnValue(future);
    expect(() => google.readGoogleCookie("flow", flow.cookie)).toThrow(); vi.restoreAllMocks();
  });
  it("fails closed without Google credentials", async () => {
    vi.stubEnv("GOOGLE_CLIENT_ID", ""); vi.resetModules(); const fresh = await import("@/server/auth/google");
    expect(fresh.googleConfigured()).toBe(false); expect(() => fresh.beginGoogleLogin()).toThrow();
  });
});
