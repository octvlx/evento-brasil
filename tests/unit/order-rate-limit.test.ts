// Decreto 13.108, R4 (tarefa L4a): limites de criação de pedido e de início de pagamento.
import { randomUUID } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { assertCanCreateOrder, assertCanStartPayment, ORDER_RATE_LIMITS } from "@/features/orders/limits";

// O limitador é um Map por processo: cada teste usa conta e IP próprios.
const uid = () => `user-${randomUUID()}`;
const ip = () => `ip-${randomUUID()}`;

const repeat = (n: number, fn: () => void) => {
  for (let i = 0; i < n; i++) fn();
};

beforeEach(() => vi.useFakeTimers());
afterEach(() => vi.useRealTimers());

describe("limites de pedido e pagamento", () => {
  const { createOrder, startPayment } = ORDER_RATE_LIMITS;

  it("criação de pedido: até o limite por conta, depois RATE_LIMITED com mensagem em pt-BR", () => {
    const user = uid();
    const client = ip();
    repeat(createOrder.perUser.limit, () => assertCanCreateOrder(user, client));
    expect(() => assertCanCreateOrder(user, client)).toThrow(
      expect.objectContaining({ code: "RATE_LIMITED", message: "Você criou muitos pedidos em pouco tempo. Aguarde alguns minutos e tente novamente." }),
    );
    // Trocar de IP não fura o limite da conta.
    expect(() => assertCanCreateOrder(user, ip())).toThrow(expect.objectContaining({ code: "RATE_LIMITED" }));
    // Outra conta não é afetada.
    expect(() => assertCanCreateOrder(uid(), ip())).not.toThrow();
  });

  it("criação de pedido: limite por IP vale entre contas diferentes", () => {
    const client = ip();
    repeat(createOrder.perClient.limit, () => assertCanCreateOrder(uid(), client));
    expect(() => assertCanCreateOrder(uid(), client)).toThrow(expect.objectContaining({ code: "RATE_LIMITED" }));
    expect(() => assertCanCreateOrder(uid(), ip())).not.toThrow();
  });

  it("a janela expira e libera novas tentativas", () => {
    const user = uid();
    const client = ip();
    repeat(createOrder.perUser.limit, () => assertCanCreateOrder(user, client));
    expect(() => assertCanCreateOrder(user, client)).toThrow();
    vi.advanceTimersByTime(createOrder.perUser.windowMs - 1);
    expect(() => assertCanCreateOrder(user, client)).toThrow();
    vi.advanceTimersByTime(1);
    expect(() => assertCanCreateOrder(user, client)).not.toThrow();
  });

  it("início de pagamento tem contador próprio, por conta e por IP", () => {
    const user = uid();
    const client = ip();
    repeat(createOrder.perUser.limit, () => assertCanCreateOrder(user, client));
    // Pedidos esgotados não bloqueiam o pagamento.
    repeat(startPayment.perUser.limit, () => assertCanStartPayment(user, client));
    expect(() => assertCanStartPayment(user, client)).toThrow(
      expect.objectContaining({ code: "RATE_LIMITED", message: "Muitas tentativas de pagamento em pouco tempo. Aguarde alguns minutos e tente novamente." }),
    );

    const shared = ip();
    repeat(startPayment.perClient.limit, () => assertCanStartPayment(uid(), shared));
    expect(() => assertCanStartPayment(uid(), shared)).toThrow(expect.objectContaining({ code: "RATE_LIMITED" }));
  });

  it("limites por IP são mais folgados que por conta (redes compartilhadas)", () => {
    expect(createOrder.perClient.limit).toBeGreaterThan(createOrder.perUser.limit);
    expect(startPayment.perClient.limit).toBeGreaterThan(startPayment.perUser.limit);
  });
});
