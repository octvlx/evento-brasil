import { beforeEach, describe, expect, it, vi } from "vitest";

const m = vi.hoisted(() => ({
  requireUser: vi.fn(),
  findOrder: vi.fn(),
  reconcile: vi.fn(),
  confirmReturned: vi.fn(),
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
vi.mock("@/server/services/payments", () => ({ confirmReturnedPayment: m.confirmReturned, handlePaymentWebhook: vi.fn(), startPayment: vi.fn() }));
vi.mock("@/server/services/checkout-review", () => ({}));
vi.mock("@/server/services/orders", () => ({}));
vi.mock("@/server/services/refunds", () => ({}));
vi.mock("@/server/services/terms", () => ({}));
vi.mock("@/features/orders/limits", () => ({}));
// O limitador real usa o banco (coberto em tests/integration/zl-rate-limit.test.ts).
vi.mock("@/server/rate-limit", () => {
  const counts = new Map<string, number>();
  return {
    rateLimit: async (key: string, limit: number) => {
      const count = (counts.get(key) ?? 0) + 1;
      counts.set(key, count);
      if (count > limit) throw Object.assign(new Error("Muitas tentativas."), { code: "RATE_LIMITED" });
    },
  };
});

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

  it("confere no provedor o id devolvido pelo Checkout Pro e ainda reconcilia o pedido", async () => {
    m.findOrder.mockResolvedValue({ userId: "buyer" });
    m.confirmReturned.mockRejectedValue(new Error("provider down"));
    const id = `order-${++n}`;
    expect(await refreshPaymentStatusAction(id, "123456")).toBe("updated");
    expect(m.confirmReturned).toHaveBeenCalledWith(expect.anything(), { id: "mercadopago" }, { id: "buyer" }, id, "123456");
    expect(m.reconcile).toHaveBeenCalledWith(expect.anything(), { id: "mercadopago" }, id);
  });

  it("sem pista na URL, não consulta pagamento por id", async () => {
    m.findOrder.mockResolvedValue({ userId: "buyer" });
    await refreshPaymentStatusAction(`order-${++n}`);
    expect(m.confirmReturned).not.toHaveBeenCalled();
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
