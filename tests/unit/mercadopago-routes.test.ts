import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";
const mocks = vi.hoisted(() => ({
  organizer: vi.fn(), current: vi.fn(), begin: vi.fn(), finish: vi.fn(),
}));
vi.mock("@/server/db", () => ({ db: {} }));
vi.mock("@/server/auth/organizer-context", () => ({ requireOrganizer: mocks.organizer }));
vi.mock("@/server/auth/current", () => ({ getCurrentUser: mocks.current }));
vi.mock("@/server/env", () => ({ env: () => ({ APP_URL: "https://market.example" }) }));
vi.mock("@/server/payments/mercadopago-oauth", () => ({ beginConnection: mocks.begin, finishConnection: mocks.finish, MP_COOKIE: "eb_mp_oauth", MP_TTL: 600 }));
import { POST } from "@/app/api/mercadopago/connect/route";
import { GET } from "@/app/api/mercadopago/callback/route";
beforeEach(() => { vi.resetAllMocks(); });
describe("Mercado Pago routes", () => {
  it("rejects missing or foreign Origin before resolving a session", async () => {
    for (const origin of [null, "https://attacker.example"]) {
      const request = new Request("https://market.example/api/mercadopago/connect", { method: "POST", headers: origin ? { Origin: origin } : {} });
      expect((await POST(request)).status).toBe(403);
    }
    expect(mocks.organizer).not.toHaveBeenCalled();
  });
  it("uses a 303 authorization redirect with an HttpOnly Secure Lax cookie", async () => {
    mocks.organizer.mockResolvedValue({ user: { id: "owner" }, org: { id: "org" } });
    mocks.begin.mockResolvedValue({ url: "https://auth.mercadopago.com.br/authorization?state=random", cookie: "encrypted-flow" });
    const response = await POST(new Request("https://market.example/api/mercadopago/connect", { method: "POST", headers: { Origin: "https://market.example" } }));
    expect(response.status).toBe(303); expect(response.headers.get("location")).toContain("https://auth.mercadopago.com.br/");
    const cookie = response.headers.get("set-cookie")!;
    for (const flag of ["HttpOnly", "Secure", "SameSite=lax", "Path=/api/mercadopago", "Max-Age=600"]) expect(cookie).toContain(flag);
    expect(response.headers.get("cache-control")).toBe("no-store");
  });
  it("clears the flow cookie and returns a safe result without an authenticated user", async () => {
    mocks.current.mockResolvedValue(null);
    const response = await GET(new NextRequest("https://market.example/api/mercadopago/callback?state=state&code=DO-NOT-LEAK"));
    expect(response.status).toBe(303); expect(response.headers.get("location")).toBe("https://market.example/organizador/configuracoes?mp=error");
    expect(response.headers.get("set-cookie")).toContain("Max-Age=0");
    expect(response.headers.get("referrer-policy")).toBe("no-referrer"); expect(mocks.finish).not.toHaveBeenCalled();
  });
  it("does not reflect provider exceptions or duplicate state into a redirect", async () => {
    mocks.current.mockResolvedValue({ id: "owner" }); mocks.finish.mockRejectedValue(new Error("DO-NOT-LEAK"));
    for (const query of ["state=x&code=secret", "state=x&state=y&code=secret"]) {
      const response = await GET(new NextRequest("https://market.example/api/mercadopago/callback?" + query, { headers: { Cookie: "eb_mp_oauth=encrypted" } }));
      expect(response.headers.get("location")).toBe("https://market.example/organizador/configuracoes?mp=error");
    }
    expect(mocks.finish).toHaveBeenCalledTimes(1);
  });
});
