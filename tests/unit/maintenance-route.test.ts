import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ reconcile: vi.fn(), complete: vi.fn(), email: vi.fn() }));
vi.mock("@/server/db", () => ({ db: {} }));
vi.mock("@/server/env", () => ({ env: () => ({ CRON_SECRET: "unit-test-secret" }) }));
vi.mock("@/server/payments", () => ({ getPaymentAdapter: () => ({}) }));
vi.mock("@/server/services/events", () => ({ completeEndedEvents: mocks.complete }));
vi.mock("@/server/services/orders", () => ({ expireStaleOrders: async () => 0 }));
vi.mock("@/server/services/half-price", () => ({ recordHalfPriceReleases: async () => 0 }));
vi.mock("@/server/services/transfers", () => ({ expireTicketTransfers: async () => 0 }));
vi.mock("@/server/services/reconciliation", () => ({ reconcilePayments: mocks.reconcile, checkFinancialInvariants: async () => [] }));
vi.mock("@/server/services/retention-purge", () => ({ runRetentionPurgeIfDue: async () => null }));
vi.mock("@/server/services/finance-log", () => ({ financeLog: vi.fn() }));
vi.mock("@/server/email/outbox", () => ({ dispatchEmailOutbox: mocks.email }));
import { POST } from "@/app/api/cron/maintenance/route";

beforeEach(() => {
  mocks.complete.mockReset().mockResolvedValue(0);
  mocks.email.mockReset().mockResolvedValue({ sent: 0 });
  mocks.reconcile.mockReset().mockResolvedValue({ errors: [] });
});

const request = () => new Request("http://localhost/api/cron/maintenance", { method: "POST", headers: { "x-cron-secret": "unit-test-secret" } });

describe("cron: erros parciais de reconciliação", () => {
  it("responde 500 e continua as etapas posteriores", async () => {
    mocks.reconcile.mockResolvedValue({ errors: [{ kind: "payment", id: "p1", message: "provider unavailable" }] });
    const response = await POST(request());
    expect(response.status).toBe(500);
    expect(await response.json()).toMatchObject({ failedSteps: ["reconcilePayments"], reconciliation: { errors: 1 } });
    expect(mocks.email).toHaveBeenCalledOnce();
  });
  it("responde 200 sem erros e protege o endpoint", async () => {
    expect((await POST(request())).status).toBe(200);
    mocks.complete.mockClear();
    expect((await POST(new Request("http://localhost/api/cron/maintenance", { method: "POST" }))).status).toBe(403);
    expect(mocks.complete).not.toHaveBeenCalled();
  });
});
