import { describe, expect, it } from "vitest";
import { checkoutStep, refundView, revocationText } from "@/features/orders/status-view";

describe("etapa do checkout", () => {
  it("escolha de método sem tentativa ativa; PIX pendente reaproveitado; cartão pendente bloqueia nova tentativa", () => {
    expect(checkoutStep([])).toBe("choose");
    expect(checkoutStep([{ status: "FAILED", method: "CREDIT_CARD" }])).toBe("choose");
    expect(checkoutStep([{ status: "PENDING", method: "PIX" }])).toBe("pix");
    expect(checkoutStep([{ status: "PENDING", method: "CREDIT_CARD" }, { status: "FAILED", method: "PIX" }])).toBe("card-processing");
  });
});

describe("situação do reembolso", () => {
  it("sem reembolso não mostra nada", () => {
    expect(refundView("PAID", [])).toBeNull();
  });

  it("solicitado: ingressos já cancelados, estorno em andamento", () => {
    const v = refundView("REFUND_PENDING", [{ status: "REQUESTED" }]);
    expect(v?.title).toBe("Reembolso em andamento");
    expect(v?.detail).toMatch(/já foram cancelados/);
    expect(refundView("REFUND_PENDING", [{ status: "PROCESSING" }])?.title).toBe("Reembolso em andamento");
  });

  it("falha no provedor vira reprocessamento, sem pedir nova solicitação", () => {
    const v = refundView("REFUND_PENDING", [{ status: "FAILED" }]);
    expect(v).toMatchObject({ tone: "warning", title: "Reembolso em reprocessamento" });
    expect(v?.detail).toMatch(/não é preciso solicitar de novo/);
  });

  it("concluído pelo status do pedido ou do reembolso mais recente", () => {
    expect(refundView("REFUNDED", [{ status: "SUCCEEDED" }])?.title).toBe("Reembolso concluído");
    expect(refundView("REFUNDED", [])?.tone).toBe("success");
    expect(refundView("PAID", [{ status: "REJECTED" }])?.tone).toBe("danger");
  });
});

describe("motivo do cancelamento do ingresso", () => {
  it("explica cada motivo e tem texto padrão", () => {
    expect(revocationText("REFUNDED")).toBe("Cancelado por reembolso do pedido");
    expect(revocationText("EVENT_CANCELLED")).toMatch(/evento foi cancelado/);
    expect(revocationText(null)).toBe("Ingresso cancelado");
  });
});
