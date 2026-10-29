import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
const sid = `VE${"a".repeat(32)}`;
const phone = "+5511999998888";
beforeEach(() => { vi.resetModules(); });
afterEach(() => { vi.unstubAllGlobals(); vi.unstubAllEnvs(); });
function configure() {
  vi.stubEnv("TWILIO_ACCOUNT_SID", `AC${"a".repeat(32)}`); vi.stubEnv("TWILIO_VERIFY_SERVICE_SID", `VA${"b".repeat(32)}`); vi.stubEnv("TWILIO_AUTH_TOKEN", "secret-not-for-clients");
}
describe("Twilio Verify server adapter", () => {
  it("fails closed without configuration", async () => {
    vi.stubEnv("TWILIO_ACCOUNT_SID", "");
    const { TwilioVerifyProvider: Fresh } = await import("@/server/phone-verification/twilio");
    const fetch = vi.fn(); vi.stubGlobal("fetch", fetch);
    await expect(new Fresh().start(phone)).rejects.toMatchObject({ code: "PROVIDER_ERROR" }); expect(fetch).not.toHaveBeenCalled();
  });
  it("validates SID, destination and status", async () => {
    configure(); const { TwilioVerifyProvider: Fresh } = await import("@/server/phone-verification/twilio");
    const fetch = vi.fn().mockResolvedValue(new Response(JSON.stringify({ sid, status: "pending", to: phone }), { status: 201 })); vi.stubGlobal("fetch", fetch);
    expect(await new Fresh().start(phone)).toBe(sid);
    fetch.mockResolvedValue(new Response(JSON.stringify({ sid, status: "approved", to: "+5521999998888" })));
    expect(await new Fresh().check(sid, phone, "123456")).toBe(false);
    fetch.mockResolvedValue(new Response(JSON.stringify({ sid: `VE${"b".repeat(32)}`, status: "approved", to: phone })));
    expect(await new Fresh().check(sid, phone, "123456")).toBe(false);
  });
  it("sanitizes provider bodies and network failures", async () => {
    configure(); const { TwilioVerifyProvider: Fresh } = await import("@/server/phone-verification/twilio");
    const fetch = vi.fn().mockResolvedValue(new Response("private-provider-response", { status: 500 })); vi.stubGlobal("fetch", fetch);
    await expect(new Fresh().start(phone)).rejects.toMatchObject({ code: "PROVIDER_ERROR" });
    fetch.mockRejectedValue(new Error("timeout includes private data"));
    await expect(new Fresh().start(phone)).rejects.toMatchObject({ code: "PROVIDER_ERROR", message: "Não foi possível verificar o celular. Tente novamente mais tarde." });
  });
});
