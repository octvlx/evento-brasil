import { beforeEach, describe, expect, it, vi } from "vitest";
import { applyPaymentSnapshot, startPayment, syncPaymentFromProvider } from "@/server/services/payments";
import { reconcilePayments, checkFinancialInvariants } from "@/server/services/reconciliation";
import { organizerFinancials } from "@/server/services/reports";
import { adapter, buy, db, makeEvent, makeOrg, makeUser, resetDb } from "../support/fixtures";

beforeEach(resetDb);

async function setup(bearer: "ORGANIZER" | "PLATFORM" = "ORGANIZER") {
  await db.commissionRule.updateMany({ data: { processingFeeBearer: bearer } });
  const owner = await makeUser();
  const org = await makeOrg(owner);
  const event = await makeEvent(org);
  const buyer = await makeUser();
  const order = await buy(buyer, event.id, [{ ticketTypeId: event.ticketTypes[0].id, quantity: 1 }]);
  return { owner, org, event, buyer, order };
}

async function confirmed(initialFee: number | null, bearer: "ORGANIZER" | "PLATFORM" = "ORGANIZER") {
  const context = await setup(bearer);
  const payment = await startPayment(db, adapter, context.buyer, context.order.id, "PIX");
  await adapter.simulate(payment.providerPaymentId!, "approve");
  const snapshot = { ...await adapter.getPayment(payment.providerPaymentId!), processingFeeCents: initialFee };
  await applyPaymentSnapshot(db, adapter, snapshot);
  return { ...context, payment, snapshot };
}

describe("recuperação das instruções PIX", () => {
  it("recupera PIX ainda pendente após resposta perdida, sem criar outra cobrança", async () => {
    const { buyer, order } = await setup();
    const create = adapter.createPayment.bind(adapter);
    const spy = vi.spyOn(adapter, "createPayment").mockImplementationOnce(async (input) => {
      await create(input);
      throw new Error("resposta perdida");
    });
    try {
      await expect(startPayment(db, adapter, buyer, order.id, "PIX")).rejects.toMatchObject({ code: "PROVIDER_ERROR" });
      const report = await reconcilePayments(db, adapter, new Date(Date.now() + 11 * 60_000));
      expect(report).toMatchObject({ paymentsLinked: 1, errors: [] });
      const recovered = await db.payment.findFirstOrThrow({ where: { orderId: order.id } });
      expect(recovered.status).toBe("PENDING");
      expect(recovered.pixCopyPaste).toBe(`SIMULADO-NAO-PAGUE-${recovered.providerPaymentId}`);
      expect(recovered.providerExpiresAt).toEqual(order.expiresAt);
      expect((await startPayment(db, adapter, buyer, order.id, "PIX")).id).toBe(recovered.id);
      expect(spy).toHaveBeenCalledTimes(1);
      expect(await db.simulatedProviderPayment.count()).toBe(1);
      expect(await db.payment.count()).toBe(1);
      expect(await db.issuedTicket.count()).toBe(0);
    } finally {
      spy.mockRestore();
    }
  });

  it("consulta normal restaura instruções faltantes e snapshot sem instruções não as apaga", async () => {
    const { buyer, order } = await setup();
    const payment = await startPayment(db, adapter, buyer, order.id, "PIX");
    await db.payment.update({ where: { id: payment.id }, data: { pixCopyPaste: null } });
    await syncPaymentFromProvider(db, adapter, payment.providerPaymentId!);
    const snapshot = await adapter.getPayment(payment.providerPaymentId!);
    const { pixCopyPaste: _code, expiresAt: _expires, ...withoutInstructions } = snapshot;
    void _code; void _expires;
    await applyPaymentSnapshot(db, adapter, withoutInstructions);
    expect(await db.payment.findUniqueOrThrow({ where: { id: payment.id } })).toMatchObject({ pixCopyPaste: snapshot.pixCopyPaste, providerExpiresAt: order.expiresAt });
    await applyPaymentSnapshot(db, adapter, { ...snapshot, pixCopyPaste: "incorrect", amountCents: snapshot.amountCents + 1 });
    expect(await db.payment.findUniqueOrThrow({ where: { id: payment.id } })).toMatchObject({ pixCopyPaste: snapshot.pixCopyPaste });
  });
});

describe("taxas de processamento recebidas depois da aprovação", () => {
  it.each(["ORGANIZER", "PLATFORM"] as const)("registra taxa tardia uma vez, mesmo em concorrência, com pagador %s", async (bearer) => {
    const { payment, snapshot, order } = await confirmed(null, bearer);
    const late = { ...snapshot, processingFeeCents: 250 };
    await Promise.all(Array.from({ length: 4 }, () => applyPaymentSnapshot(db, adapter, late)));
    const entries = await db.financialLedgerEntry.findMany({ where: { paymentId: payment.id, type: "PROCESSING_FEE" } });
    expect(entries).toHaveLength(2);
    expect(entries).toEqual(expect.arrayContaining([
      expect.objectContaining({ account: "PROCESSING_FEES", direction: "CREDIT", amountCents: 250 }),
      expect.objectContaining({ account: bearer === "ORGANIZER" ? "ORGANIZER_PAYABLE" : "PLATFORM_COMMISSION", direction: "DEBIT", amountCents: 250 }),
    ]));
    expect(await db.payment.findUniqueOrThrow({ where: { id: payment.id } })).toMatchObject({ processingFeeCents: 250 });
    await applyPaymentSnapshot(db, adapter, snapshot); // null não apaga o valor conhecido
    expect(await db.payment.findUniqueOrThrow({ where: { id: payment.id } })).toMatchObject({ processingFeeCents: 250 });
    expect(await db.issuedTicket.count({ where: { orderId: order.id } })).toBe(1);
    expect(await checkFinancialInvariants(db)).toEqual([]);
  });

  it("reconciliação periódica também grava taxa descoberta mais tarde", async () => {
    const { payment, snapshot } = await confirmed(0);
    const spy = vi.spyOn(adapter, "getPayment").mockResolvedValue({ ...snapshot, processingFeeCents: 350 });
    try {
      expect(await reconcilePayments(db, adapter, new Date(Date.now() + 11 * 60_000))).toMatchObject({ settledPaymentsSynced: 1, errors: [] });
      expect(await db.payment.findUniqueOrThrow({ where: { id: payment.id } })).toMatchObject({ processingFeeCents: 350 });
      expect(await db.financialLedgerEntry.count({ where: { paymentId: payment.id, type: "PROCESSING_FEE" } })).toBe(2);
    } finally {
      spy.mockRestore();
    }
  });

  it("corrige total para cima, para baixo e zero sem alterar lançamentos antigos nem inflar relatório", async () => {
    const { owner, org, payment, snapshot } = await confirmed(200);
    const original = await db.financialLedgerEntry.findMany({ where: { paymentId: payment.id, type: "PROCESSING_FEE" } });
    for (const fee of [300, 100, 0, 300]) {
      const update = { ...snapshot, processingFeeCents: fee };
      await applyPaymentSnapshot(db, adapter, update);
      await applyPaymentSnapshot(db, adapter, update);
      const entries = await db.financialLedgerEntry.findMany({ where: { paymentId: payment.id, account: "PROCESSING_FEES" } });
      expect(entries.reduce((sum, row) => sum + (row.direction === "CREDIT" ? row.amountCents : -row.amountCents), 0)).toBe(fee);
      expect((await organizerFinancials(db, owner, org.id)).processingFeeCents).toBe(fee);
    }
    expect(await db.financialLedgerEntry.findMany({ where: { id: { in: original.map((row) => row.id) } } })).toEqual(original);
    expect(await checkFinancialInvariants(db)).toEqual([]);
  });

  it("resolução de disputa registra taxa conhecida sem repetir a venda", async () => {
    const { payment, snapshot } = await confirmed(null);
    await applyPaymentSnapshot(db, adapter, { ...snapshot, status: "DISPUTED" });
    await applyPaymentSnapshot(db, adapter, { ...snapshot, processingFeeCents: 400 });
    expect(await db.payment.findUniqueOrThrow({ where: { id: payment.id } })).toMatchObject({ status: "PAID", processingFeeCents: 400 });
    expect(await db.financialLedgerEntry.count({ where: { paymentId: payment.id, type: "PROCESSING_FEE" } })).toBe(2);
  });

  it("taxa inválida não altera saldo nem pagamento", async () => {
    const { payment, snapshot } = await confirmed(null);
    for (const processingFeeCents of [-1, 0.5, NaN, 2_147_483_648]) {
      await expect(applyPaymentSnapshot(db, adapter, { ...snapshot, processingFeeCents })).rejects.toThrow(/Taxa de processamento inválida/);
    }
    expect(await db.financialLedgerEntry.count({ where: { paymentId: payment.id, type: "PROCESSING_FEE" } })).toBe(0);
    expect(await db.payment.findUniqueOrThrow({ where: { id: payment.id } })).toMatchObject({ processingFeeCents: null, status: "PAID" });
  });
});
