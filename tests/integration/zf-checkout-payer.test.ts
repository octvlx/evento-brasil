import { beforeEach, describe, expect, it, vi } from "vitest";
import { startPayment } from "@/server/services/payments";
import { SimulatedPaymentAdapter } from "@/server/payments/simulated";
import type { CreatePaymentInput, PayerRequirements } from "@/server/payments/types";
import { adapter, buy, db, makeEvent, makeOrg, makeUser, resetDb } from "../support/fixtures";

beforeEach(resetDb);

class DocumentAdapter extends SimulatedPaymentAdapter {
  payerRequirements(): PayerRequirements { return { document: ["CPF"] }; }
}
async function setup() {
  const owner = await makeUser();
  const org = await makeOrg(owner);
  const event = await makeEvent(org, { tickets: [{ priceCents: 10000, quantityTotal: 10 }] });
  const buyer = await makeUser();
  const order = await buy(buyer, event.id, [{ ticketTypeId: event.ticketTypes[0].id, quantity: 1 }]);
  return { buyer, order };
}

describe("checkout payer data is collected at payment time", () => {
  it("rejects missing/invalid provider-required CPF before recording or calling a payment", async () => {
    const { buyer, order } = await setup();
    const provider = new DocumentAdapter(db, process.env.SIMULATED_WEBHOOK_SECRET!);
    const charge = vi.spyOn(provider, "createPayment");
    await expect(startPayment(db, provider, buyer, order.id, "PIX")).rejects.toMatchObject({ code: "VALIDATION" });
    await expect(startPayment(db, provider, buyer, order.id, "PIX", { payerDetails: { document: { type: "CPF", number: "11111111111" } } })).rejects.toMatchObject({ code: "VALIDATION" });
    expect(charge).not.toHaveBeenCalled();
    expect(await db.payment.count()).toBe(0);
    const other = await makeUser();
    await expect(startPayment(db, provider, other, order.id, "PIX")).rejects.toMatchObject({ code: "FORBIDDEN" });
  });
  it("forwards sanitized details only to provider and reuses existing PIX without recollection", async () => {
    const { buyer, order } = await setup();
    const provider = new DocumentAdapter(db, process.env.SIMULATED_WEBHOOK_SECRET!);
    const charge = vi.spyOn(provider, "createPayment");
    const payment = await startPayment(db, provider, buyer, order.id, "PIX", { payerDetails: { document: { type: "CPF", number: "529.982.247-25" }, password: "must-not-forward" } });
    expect(charge.mock.calls[0][0].payer).toEqual({ email: order.buyerEmail, name: order.buyerName, document: { type: "CPF", number: "52998224725" } });
    expect((await startPayment(db, provider, buyer, order.id, "PIX")).id).toBe(payment.id);
    expect(charge).toHaveBeenCalledTimes(1);
    expect(JSON.stringify(await db.auditLog.findMany())).not.toContain("52998224725");
    expect((await db.user.findUniqueOrThrow({ where: { id: buyer.id } })).phone).toBeNull();
  });
  it("simulated minimal checkout needs no extra data and drops unsolicited data", async () => {
    const { buyer, order } = await setup();
    let sent: CreatePaymentInput | undefined;
    const charge = vi.spyOn(adapter, "createPayment").mockImplementationOnce(async (input) => { sent = input; return SimulatedPaymentAdapter.prototype.createPayment.call(adapter, input); });
    const payment = await startPayment(db, adapter, buyer, order.id, "PIX", { payerDetails: { document: { type: "CPF", number: "52998224725" }, billingAddress: {} } });
    expect(payment.status).toBe("PENDING");
    expect(sent!.payer).toEqual({ email: order.buyerEmail, name: order.buyerName });
    charge.mockRestore();
  });
});
