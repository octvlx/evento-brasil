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

describe("Twilio Verify defensive response handling", () => {
  it("maps provider throttling to a safe rate-limit error", async () => {
    configure(); const { TwilioVerifyProvider: Fresh } = await import("@/server/phone-verification/twilio");
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response("sensitive-provider-body", { status: 429 })));
    await expect(new Fresh().start(phone)).rejects.toMatchObject({ code: "RATE_LIMITED", message: "Muitas tentativas. Aguarde antes de tentar novamente." });
  });
  it("does not approve pending wrong-code checks or reuse an already approved start", async () => {
    configure(); const { TwilioVerifyProvider: Fresh } = await import("@/server/phone-verification/twilio");
    const fetch = vi.fn().mockResolvedValue(new Response(JSON.stringify({ sid, status: "pending", to: phone }))); vi.stubGlobal("fetch", fetch);
    expect(await new Fresh().check(sid, phone, "000000")).toBe(false);
    fetch.mockResolvedValue(new Response(JSON.stringify({ sid, status: "approved", to: phone })));
    await expect(new Fresh().start(phone)).rejects.toMatchObject({ code: "PROVIDER_ERROR" });
  });
  it("rejects malformed successful provider responses safely", async () => {
    configure(); const { TwilioVerifyProvider: Fresh } = await import("@/server/phone-verification/twilio");
    const fetch = vi.fn().mockResolvedValue(new Response("not-json")); vi.stubGlobal("fetch", fetch);
    await expect(new Fresh().start(phone)).rejects.toMatchObject({ code: "PROVIDER_ERROR" });
    fetch.mockResolvedValue(new Response(JSON.stringify({ status: "pending", to: phone })));
    await expect(new Fresh().start(phone)).rejects.toMatchObject({ code: "PROVIDER_ERROR" });
  });
});
