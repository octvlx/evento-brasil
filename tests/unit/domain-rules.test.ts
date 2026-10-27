import { describe, expect, it } from "vitest";
import { assertEventTransition } from "@/server/services/events";
import { parseQrPayload, qrPayload } from "@/server/services/tickets";
import { refundEligibility } from "@/server/services/refunds";
import { availabilityOf } from "@/server/services/catalog";
import { roleHas } from "@/server/auth/permissions";

describe("ciclo de vida do evento", () => {
  it("permite transições válidas e bloqueia inválidas", () => {
    expect(() => assertEventTransition("DRAFT", "PENDING_REVIEW")).not.toThrow();
    expect(() => assertEventTransition("PUBLISHED", "CANCELLED")).not.toThrow();
    expect(() => assertEventTransition("CANCELLED", "PUBLISHED")).toThrow();
    expect(() => assertEventTransition("ARCHIVED", "DRAFT")).toThrow();
    expect(() => assertEventTransition("COMPLETED", "CANCELLED")).toThrow();
  });
});

describe("QR code", () => {
  it("ida e volta do payload e rejeição de formatos inválidos", () => {
    const t = { code: "ABCDEFGH12", validationToken: "a".repeat(43) };
    expect(parseQrPayload(qrPayload(t))).toEqual({ code: t.code, token: t.validationToken });
    expect(parseQrPayload("EB1:ABCDEFGH12:curto")).toBeNull();
    expect(parseQrPayload("12345")).toBeNull();
    expect(parseQrPayload("EB1:ABCDEFGHI1:" + "a".repeat(43))).toBeNull(); // 'I' fora do alfabeto
  });
});

describe("elegibilidade de reembolso", () => {
  const now = new Date("2026-11-01T12:00:00Z");
  const paid = { status: "PAID", paidAt: new Date("2026-10-30T12:00:00Z"), totalCents: 1000 };
  const event = { status: "PUBLISHED", startsAt: new Date("2026-11-20T23:00:00Z"), refundWindowDays: 7, refundMinHoursBeforeEvent: 48 };
  it("elegível dentro das janelas", () => expect(refundEligibility(paid, event, [{ status: "VALID" }], now).eligible).toBe(true));
  it("fora do prazo da compra", () =>
    expect(refundEligibility({ ...paid, paidAt: new Date("2026-10-20T12:00:00Z") }, event, [], now).eligible).toBe(false));
  it("muito perto do evento", () =>
    expect(refundEligibility(paid, { ...event, startsAt: new Date("2026-11-02T12:00:00Z") }, [], now).eligible).toBe(false));
  it("ingresso já utilizado", () => expect(refundEligibility(paid, event, [{ status: "CHECKED_IN" }], now).eligible).toBe(false));
  it("pedido não pago", () => expect(refundEligibility({ ...paid, status: "PENDING_PAYMENT" }, event, [], now).eligible).toBe(false));
  it("usa os prazos do próprio evento", () => {
    // Pago há 2 dias, evento em 19 dias: fora com 1 dia de prazo; fora com 500h de antecedência.
    expect(refundEligibility(paid, { ...event, refundWindowDays: 1 }, [], now)).toEqual({ eligible: false, reason: "O prazo de 1 dia após a compra terminou." });
    expect(refundEligibility(paid, { ...event, refundMinHoursBeforeEvent: 500 }, [], now)).toEqual({ eligible: false, reason: "Reembolsos só até 500h antes do evento." });
    // Prazos mais generosos tornam elegível o que o padrão recusaria.
    expect(refundEligibility({ ...paid, paidAt: new Date("2026-10-20T12:00:00Z") }, { ...event, refundWindowDays: 30 }, [], now).eligible).toBe(true);
    expect(refundEligibility(paid, { ...event, startsAt: new Date("2026-11-02T12:00:00Z"), refundMinHoursBeforeEvent: 0 }, [], now).eligible).toBe(true);
  });
});

describe("disponibilidade e papéis", () => {
  const now = new Date("2026-11-01T12:00:00Z");
  const ev = { capacity: 100, salesStartAt: new Date("2026-10-01"), salesEndAt: new Date("2026-12-01") };
  it("calcula estados de disponibilidade", () => {
    expect(availabilityOf(ev, [{ quantityTotal: 100, quantityReserved: 0, quantitySold: 10 }], now)).toBe("AVAILABLE");
    expect(availabilityOf(ev, [{ quantityTotal: 100, quantityReserved: 5, quantitySold: 90 }], now)).toBe("LOW");
    expect(availabilityOf(ev, [{ quantityTotal: 100, quantityReserved: 10, quantitySold: 90 }], now)).toBe("SOLD_OUT");
    expect(availabilityOf({ ...ev, salesStartAt: new Date("2026-11-10") }, [], now)).toBe("NOT_STARTED");
    expect(availabilityOf({ ...ev, salesEndAt: new Date("2026-10-31") }, [], now)).toBe("CLOSED");
  });
  it("equipe de check-in não lê participantes nem finanças", () => {
    expect(roleHas("CHECKIN_STAFF", "checkin:scan")).toBe(true);
    expect(roleHas("CHECKIN_STAFF", "attendees:read")).toBe(false);
    expect(roleHas("CHECKIN_STAFF", "finance:read")).toBe(false);
    expect(roleHas("FINANCE", "event:write")).toBe(false);
    expect(roleHas("EVENT_MANAGER", "finance:read")).toBe(false);
  });
});
