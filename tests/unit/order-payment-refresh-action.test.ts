import { beforeEach, describe, expect, it, vi } from "vitest";

const m = vi.hoisted(() => ({
  requireUser: vi.fn(),
  findOrder: vi.fn(),
  reconcile: vi.fn(),
  refresh: vi.fn(),
}));
vi.mock("next/headers", () => ({ cookies: vi.fn(), headers: vi.fn() }));
vi.mock("next/navigation", () => ({ redirect: vi.fn() }));
vi.mock("next/cache", () => ({ refresh: m.refresh }));
vi.mock("@/server/db", () => ({ db: { order: { findUnique: m.findOrder } } }));
vi.mock("@/server/env", () => ({ env: () => ({}), isProduction: () => false }));
vi.mock("@/server/auth/current", () => ({ requireUser: m.requireUser, getCurrentUser: vi.fn(), requireAdmin: vi.fn() }));
vi.mock("@/server/payments", () => ({ getPaymentAdapter: () => ({ id: "mercadopago" }), getSimulatedAdapter: vi.fn() }));
vi.mock("@/server/services/reconciliation", () => ({ reconcileOrderPayments: m.reconcile }));
vi.mock("@/server/services/payments", () => ({ handlePaymentWebhook: vi.fn(), startPayment: vi.fn() }));
vi.mock("@/server/services/checkout-review", () => ({}));
vi.mock("@/server/services/orders", () => ({}));
vi.mock("@/server/services/refunds", () => ({}));
vi.mock("@/server/services/terms", () => ({}));
vi.mock("@/features/orders/limits", () => ({}));

import { refreshPaymentStatusAction } from "@/features/orders/actions";

let n = 0;
beforeEach(() => {
  vi.resetAllMocks();
  m.requireUser.mockResolvedValue({ id: "buyer" });
  m.reconcile.mockResolvedValue("updated");
});

describe("refreshPaymentStatusAction", () => {
  it("só o dono do pedido dispara a reconciliação", async () => {
    m.findOrder.mockResolvedValue({ userId: "someone-else" });
    expect(await refreshPaymentStatusAction(`order-${++n}`)).toBe("forbidden");
    m.findOrder.mockResolvedValue(null);
    expect(await refreshPaymentStatusAction(`order-${++n}`)).toBe("forbidden");
    expect(m.reconcile).not.toHaveBeenCalled();
  });

  it("reconcilia o pedido do comprador pelo id do pedido (sem ids de pagamento vindos do cliente)", async () => {
    m.findOrder.mockResolvedValue({ userId: "buyer" });
    const id = `order-${++n}`;
    expect(await refreshPaymentStatusAction(id)).toBe("updated");
    expect(m.reconcile).toHaveBeenCalledWith(expect.anything(), { id: "mercadopago" }, id);
    expect(m.refresh).toHaveBeenCalled();
  });

  it("limita a frequência por comprador e pedido", async () => {
    m.findOrder.mockResolvedValue({ userId: "buyer" });
    const id = `order-${++n}`;
    const results = [];
    for (let i = 0; i < 12; i++) results.push(await refreshPaymentStatusAction(id));
    expect(results.filter((r) => r === "rate_limited")).toHaveLength(2);
    expect(m.reconcile).toHaveBeenCalledTimes(10);
  });
});
