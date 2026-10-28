// Razão interno de partidas dobradas para conciliação (não é custódia).
// Contas (saldo natural):
//   CUSTOMER_FUNDS        débito = dinheiro recebido de compradores via provedor
//   ORGANIZER_PAYABLE     crédito = valor devido ao organizador
//   PLATFORM_COMMISSION   crédito = receita de comissão
//   PLATFORM_SERVICE_FEE  crédito = taxa de serviço cobrada do comprador
//   PROCESSING_FEES       crédito = custo devido ao processador
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

/** Estorno integral. Se a comissão não é devolvida, o organizador arca com ela. */
export async function postReversal(
  tx: Tx,
  kind: "REFUND" | "CHARGEBACK",
  order: OrderAmounts,
  opts: { refundId?: string; paymentId?: string; returnCommission: boolean },
) {
  const commissionOnly = order.commissionCents - order.serviceFeeCents;
  const entries: Entry[] = opts.returnCommission
    ? [
        { account: "ORGANIZER_PAYABLE", direction: "DEBIT", amountCents: order.totalCents - order.commissionCents, description: "Estorno do repasse" },
        { account: "PLATFORM_COMMISSION", direction: "DEBIT", amountCents: commissionOnly, description: "Estorno da comissão" },
        { account: "PLATFORM_SERVICE_FEE", direction: "DEBIT", amountCents: order.serviceFeeCents, description: "Estorno da taxa de serviço" },
      ]
    : [{ account: "ORGANIZER_PAYABLE", direction: "DEBIT", amountCents: order.totalCents, description: "Estorno integral (comissão retida)" }];
  entries.push({ account: "CUSTOMER_FUNDS", direction: "CREDIT", amountCents: order.totalCents, description: kind === "REFUND" ? "Reembolso ao comprador" : "Chargeback" });
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
}
