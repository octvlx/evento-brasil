// Razão interno de partidas dobradas para conciliação (não é custódia).
// Contas (saldo natural):
//   CUSTOMER_FUNDS        débito = dinheiro recebido de compradores via provedor
//   ORGANIZER_PAYABLE     crédito = valor devido ao organizador
//   PLATFORM_COMMISSION   crédito = receita de comissão
//   PLATFORM_SERVICE_FEE  crédito = taxa de serviço cobrada do comprador
//   PROCESSING_FEES       crédito = custo devido ao processador
//   ORGANIZER_RECEIVABLE  débito = o organizador deve à plataforma (split; ver postSplitTrueUp)
//
// Com o split do Mercado Pago, ORGANIZER_PAYABLE segue o que ficou de fato na conta do
// organizador; o líquido dele é ORGANIZER_PAYABLE − ORGANIZER_RECEIVABLE.
import "server-only";
import type { CommissionRule, LedgerAccount, LedgerDirection, LedgerEntryType, Order } from "@/generated/prisma/client";
import type { Tx } from "../db";

interface Entry {
  account: LedgerAccount;
  direction: LedgerDirection;
  amountCents: number;
  description: string;
}

interface PostInput {
  idempotencyKey: string;
  type: LedgerEntryType;
  organizationId: string;
  orderId?: string;
  paymentId?: string;
  refundId?: string;
  feePolicyVersion?: string;
  isSimulated: boolean;
  entries: Entry[];
}

export class UnbalancedLedgerError extends Error {}

/** Grava uma transação contábil balanceada. Reexecuções com a mesma chave são ignoradas. */
export async function postLedgerTransaction(tx: Tx, input: PostInput): Promise<void> {
  const merged = new Map<string, Entry>();
  for (const e of input.entries) {
    if (!Number.isSafeInteger(e.amountCents) || e.amountCents < 0) throw new UnbalancedLedgerError("Valor inválido no razão");
    if (e.amountCents === 0) continue;
    const key = `${e.account}:${e.direction}`;
    const prev = merged.get(key);
    merged.set(key, prev ? { ...prev, amountCents: prev.amountCents + e.amountCents } : { ...e });
  }
  const entries = [...merged.values()];
  const debit = entries.filter((e) => e.direction === "DEBIT").reduce((s, e) => s + e.amountCents, 0);
  const credit = entries.filter((e) => e.direction === "CREDIT").reduce((s, e) => s + e.amountCents, 0);
  if (debit !== credit) throw new UnbalancedLedgerError(`Transação desbalanceada: D ${debit} ≠ C ${credit}`);
  if (!entries.length) return;
  await tx.financialLedgerEntry.createMany({
    data: entries.map((e) => ({
      idempotencyKey: input.idempotencyKey,
      type: input.type,
      account: e.account,
      direction: e.direction,
      amountCents: e.amountCents,
      organizationId: input.organizationId,
      orderId: input.orderId,
      paymentId: input.paymentId,
      refundId: input.refundId,
      feePolicyVersion: input.feePolicyVersion,
      description: e.description,
      isSimulated: input.isSimulated,
    })),
    skipDuplicates: true,
  });
}

type OrderAmounts = Pick<Order, "id" | "organizationId" | "totalCents" | "commissionCents" | "serviceFeeCents" | "feePolicyVersion" | "isSimulated">;

export async function postSale(tx: Tx, order: OrderAmounts, paymentId: string | undefined) {
  await postSaleEntries(tx, order, paymentId);
  if (paymentId) await postFeeRecovery(tx, order, paymentId);
}

async function postSaleEntries(tx: Tx, order: OrderAmounts, paymentId: string | undefined) {
  const commissionOnly = order.commissionCents - order.serviceFeeCents;
  await postLedgerTransaction(tx, {
    idempotencyKey: `sale:${order.id}`,
    type: "SALE",
    organizationId: order.organizationId,
    orderId: order.id,
    paymentId,
    feePolicyVersion: order.feePolicyVersion,
    isSimulated: order.isSimulated,
    entries: [
      { account: "CUSTOMER_FUNDS", direction: "DEBIT", amountCents: order.totalCents, description: "Pagamento recebido" },
      { account: "ORGANIZER_PAYABLE", direction: "CREDIT", amountCents: order.totalCents - order.commissionCents, description: "Repasse ao organizador" },
      { account: "PLATFORM_COMMISSION", direction: "CREDIT", amountCents: commissionOnly, description: "Comissão da plataforma" },
      { account: "PLATFORM_SERVICE_FEE", direction: "CREDIT", amountCents: order.serviceFeeCents, description: "Taxa de serviço" },
    ],
  });
}

export async function postProcessingFee(
  tx: Tx,
  order: OrderAmounts,
  paymentId: string,
  feeCents: number,
  bearer: CommissionRule["processingFeeBearer"],
) {
  if (!Number.isSafeInteger(feeCents) || feeCents < 0 || feeCents > 2_147_483_647) throw new UnbalancedLedgerError("Taxa de processamento inválida");
  // O provedor informa o total, não um novo débito. Correções são novas partidas,
  // sem alterar o histórico. Pré-condição: trava do pedido, como postSale.
  const previous = await tx.financialLedgerEntry.findMany({
    where: { paymentId, type: "PROCESSING_FEE", account: "PROCESSING_FEES" },
    select: { amountCents: true, direction: true },
  });
  const recorded = previous.reduce((sum, entry) => sum + (entry.direction === "CREDIT" ? entry.amountCents : -entry.amountCents), 0);
  const delta = feeCents - recorded;
  if (!delta) return;
  await postLedgerTransaction(tx, {
    idempotencyKey: previous.length ? `processing-fee:${paymentId}:revision:${previous.length + 1}` : `processing-fee:${paymentId}`,
    type: "PROCESSING_FEE",
    organizationId: order.organizationId,
    orderId: order.id,
    paymentId,
    feePolicyVersion: order.feePolicyVersion,
    isSimulated: order.isSimulated,
    entries: [
      {
        account: bearer === "ORGANIZER" ? "ORGANIZER_PAYABLE" : "PLATFORM_COMMISSION",
        direction: delta > 0 ? "DEBIT" : "CREDIT",
        amountCents: Math.abs(delta),
        description: bearer === "ORGANIZER" ? "Custo de processamento (organizador)" : "Custo de processamento (plataforma)",
      },
      { account: "PROCESSING_FEES", direction: delta > 0 ? "CREDIT" : "DEBIT", amountCents: Math.abs(delta), description: "Custo de processamento" },
    ],
  });
}

/**
 * Compensação cobrada junto com esta venda (somada ao marketplace_fee): o organizador
 * recebeu `feeRecoveryCents` a menos, que abatem o saldo devedor dele.
 */
async function postFeeRecovery(tx: Tx, order: OrderAmounts, paymentId: string) {
  const payment = await tx.payment.findUnique({ where: { id: paymentId }, select: { feeRecoveryCents: true } });
  const recovered = payment?.feeRecoveryCents ?? 0;
  if (recovered <= 0) return;
  await postLedgerTransaction(tx, {
    idempotencyKey: `fee-recovery:${paymentId}`,
    type: "ADJUSTMENT",
    organizationId: order.organizationId,
    orderId: order.id,
    paymentId,
    feePolicyVersion: order.feePolicyVersion,
    isSimulated: order.isSimulated,
    entries: [
      { account: "ORGANIZER_PAYABLE", direction: "DEBIT", amountCents: recovered, description: "Compensação de saldo devedor nesta venda" },
      { account: "ORGANIZER_RECEIVABLE", direction: "CREDIT", amountCents: recovered, description: "Saldo devedor compensado" },
    ],
  });
}

/** Saldo devedor do organizador no razão (positivo = deve à plataforma). */
export async function organizerReceivableCents(tx: Tx, organizationId: string) {
  const rows = await tx.financialLedgerEntry.groupBy({ by: ["direction"], where: { organizationId, account: "ORGANIZER_RECEIVABLE" }, _sum: { amountCents: true } });
  const sum = (d: LedgerDirection) => rows.find((r) => r.direction === d)?._sum.amountCents ?? 0;
  return sum("DEBIT") - sum("CREDIT");
}

/**
 * Compensação a somar ao marketplace_fee de uma nova cobrança do organizador: o saldo
 * devedor menos o já reservado em cobranças pendentes, até metade da parte dele nesta
 * venda. A trava por organização impede que duas cobranças simultâneas reservem a mesma
 * dívida. Cobrança que expira ou falha libera a reserva (deixa de ser PENDING).
 */
export async function reserveFeeRecoveryCents(tx: Tx, organizationId: string, order: { totalCents: number; commissionCents: number }) {
  const cap = Math.floor((order.totalCents - order.commissionCents) / 2);
  if (cap <= 0) return 0;
  await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${`fee-recovery:${organizationId}`}))`;
  const owed = await organizerReceivableCents(tx, organizationId);
  if (owed <= 0) return 0;
  const reserved = await tx.payment.aggregate({ where: { status: "PENDING", order: { organizationId } }, _sum: { feeRecoveryCents: true } });
  return Math.max(0, Math.min(owed - (reserved._sum.feeRecoveryCents ?? 0), cap));
}

/**
 * Quanto da comissão o split do Mercado Pago tira da conta da plataforma num estorno:
 * proporcional ao valor estornado sobre o total da cobrança ("dividido e subtraído da
 * conta do vendedor e da conta do Marketplace, sendo proporcional para as partes").
 */
export function splitPlatformDebitCents(refundCents: number, payment: { amountCents: number; feeCents: number }) {
  if (payment.amountCents <= 0) return 0;
  return Math.round((refundCents * payment.feeCents) / payment.amountCents);
}

/** Estorno integral. Se a comissão não é devolvida, o organizador arca com ela. */
export async function postReversal(
  tx: Tx,
  kind: "REFUND" | "CHARGEBACK",
  order: OrderAmounts,
  opts: {
    refundId?: string;
    paymentId?: string;
    returnCommission: boolean;
    retainedCents?: number;
    /** Cobrança com split (pagamento real): total e marketplace_fee efetivamente enviados. */
    split?: { amountCents: number; feeCents: number };
  },
) {
  const commissionOnly = order.commissionCents - order.serviceFeeCents;
  // Valor fixo retido (não devolvido ao comprador): fica com a plataforma. Sai primeiro da
  // taxa de serviço (comprador paga a comissão) e, se não houver, da comissão.
  const retained = opts.retainedCents ?? 0;
  if (!Number.isSafeInteger(retained) || retained < 0 || retained > order.commissionCents) throw new UnbalancedLedgerError("Valor retido inválido");
  const retainedFromFee = Math.min(retained, order.serviceFeeCents);
  const retainedFromCommission = retained - retainedFromFee;
  const refunded = order.totalCents - retained;
  const entries: Entry[] = opts.returnCommission
    ? [
        { account: "ORGANIZER_PAYABLE", direction: "DEBIT", amountCents: order.totalCents - order.commissionCents, description: "Estorno do repasse" },
        { account: "PLATFORM_COMMISSION", direction: "DEBIT", amountCents: commissionOnly - retainedFromCommission, description: "Estorno da comissão" },
        { account: "PLATFORM_SERVICE_FEE", direction: "DEBIT", amountCents: order.serviceFeeCents - retainedFromFee, description: "Estorno da taxa de serviço" },
      ]
    : [{ account: "ORGANIZER_PAYABLE", direction: "DEBIT", amountCents: refunded, description: "Estorno integral (comissão retida)" }];
  entries.push({
    account: "CUSTOMER_FUNDS",
    direction: "CREDIT",
    amountCents: refunded,
    description: kind === "REFUND" ? (retained ? "Reembolso ao comprador (valor fixo retido)" : "Reembolso ao comprador") : "Chargeback",
  });
  await postLedgerTransaction(tx, {
    idempotencyKey: `${kind.toLowerCase()}:${opts.refundId ?? opts.paymentId ?? order.id}`,
    type: kind,
    organizationId: order.organizationId,
    orderId: order.id,
    paymentId: opts.paymentId,
    refundId: opts.refundId,
    feePolicyVersion: order.feePolicyVersion,
    isSimulated: order.isSimulated,
    entries,
  });
  if (opts.split && opts.refundId) {
    const platformDue = opts.returnCommission ? commissionOnly - retainedFromCommission + order.serviceFeeCents - retainedFromFee : 0;
    await postSplitTrueUp(tx, order, opts.refundId, opts.paymentId, splitPlatformDebitCents(refunded, opts.split) - platformDue);
  }
}

/**
 * Acerto do split no estorno: o provedor tirou `deltaCents` a mais (positivo) da conta da
 * plataforma do que o razão atribui a ela, e a menos da conta do organizador. Ele fica com
 * esse valor em caixa e passa a devê-lo (ORGANIZER_RECEIVABLE), compensado nas próximas
 * cobranças (Payment.feeRecoveryCents). Negativo: a plataforma ficou com mais do que devia,
 * e o saldo devedor diminui.
 */
async function postSplitTrueUp(tx: Tx, order: OrderAmounts, refundId: string, paymentId: string | undefined, deltaCents: number) {
  if (!deltaCents) return;
  const owes = deltaCents > 0;
  const amountCents = Math.abs(deltaCents);
  await postLedgerTransaction(tx, {
    idempotencyKey: `split-true-up:${refundId}`,
    type: "ADJUSTMENT",
    organizationId: order.organizationId,
    orderId: order.id,
    paymentId,
    refundId,
    feePolicyVersion: order.feePolicyVersion,
    isSimulated: order.isSimulated,
    entries: [
      { account: "ORGANIZER_RECEIVABLE", direction: owes ? "DEBIT" : "CREDIT", amountCents, description: owes ? "Saldo devedor: comissão que o split devolveu da conta da plataforma" : "Saldo devedor reduzido pelo split" },
      { account: "ORGANIZER_PAYABLE", direction: owes ? "CREDIT" : "DEBIT", amountCents, description: owes ? "Estorno debitado a menos do organizador (split)" : "Estorno debitado a mais do organizador (split)" },
    ],
  });
}
