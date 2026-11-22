import { describe, expect, it, vi } from "vitest";

vi.mock("@/server/env", () => ({ env: () => ({ CRON_SECRET: "unit-test-cron-secret" }) }));
import { isCronAuthorized } from "@/server/cron-auth";

const req = (headers: Record<string, string>) => new Request("http://localhost/api/cron/maintenance", { method: "POST", headers });

describe("isCronAuthorized", () => {
  it("aceita o x-cron-secret certo (agendador externo e monitor)", () => {
    expect(isCronAuthorized(req({ "x-cron-secret": "unit-test-cron-secret" }))).toBe(true);
  });

  it("aceita Authorization: Bearer (Vercel Schedules)", () => {
    expect(isCronAuthorized(req({ authorization: "Bearer unit-test-cron-secret" }))).toBe(true);
    expect(isCronAuthorized(req({ authorization: "bearer unit-test-cron-secret" }))).toBe(true);
  });

  it("recusa segredo errado, ausente ou em outro esquema", () => {
    expect(isCronAuthorized(req({}))).toBe(false);
    expect(isCronAuthorized(req({ "x-cron-secret": "errado" }))).toBe(false);
    expect(isCronAuthorized(req({ authorization: "Bearer errado" }))).toBe(false);
    expect(isCronAuthorized(req({ authorization: "Basic unit-test-cron-secret" }))).toBe(false);
    expect(isCronAuthorized(req({ authorization: "unit-test-cron-secret" }))).toBe(false);
    expect(isCronAuthorized(req({ authorization: "Bearer unit-test-cron-secret extra" }))).toBe(false);
  });

  it("x-cron-secret errado não é salvo por um Bearer certo", () => {
    expect(isCronAuthorized(req({ "x-cron-secret": "errado", authorization: "Bearer unit-test-cron-secret" }))).toBe(false);
  });
});
