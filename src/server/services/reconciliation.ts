// Reconciliação e verificação de invariantes financeiros.
//
// O provedor é a fonte da verdade para pagamentos; o banco é a fonte da verdade
// para estoque, ingressos e razão. Este módulo recupera o que ficou para trás
// quando um webhook se perde ou o processo cai no meio de uma operação, e
// detecta (sem corrigir em silêncio) qualquer inconsistência.
import "server-only";
import type { Db } from "../db";
import type { PaymentProviderAdapter } from "../payments/types";
import { applyPaymentSnapshot, syncPaymentFromProvider } from "./payments";
import { resumeRefund, retryFailedRefunds } from "./refunds";

export interface ReconciliationReport {
  webhooksReprocessed: number;
  paymentsSynced: number;
  paymentsLinked: number;
  paymentsClosedNotFound: number;
  paymentsNeedReview: number;
  refundsResumed: number;
  /** Reembolsos FAILED reprocessados automaticamente nesta rodada (e quantos deram certo). */
  refundsRetried: number;
  refundsRetrySucceeded: number;
  /** Reembolsos FAILED que esgotaram as tentativas ou foram bloqueados: exigem o admin. */
  refundsAwaitingAdminDecision: number;
  errors: { kind: string; id: string; orderId?: string; message: string }[];
}

const WEBHOOK_GRACE_MS = 2 * 60_000;

/**
 * Idempotente: pode rodar a cada minuto (cron). Considera "parado" o que está
 * sem progresso há `staleMinutes`.
 */
export async function reconcilePayments(
  db: Db,
  adapter: PaymentProviderAdapter,
  now = new Date(),
  opts: { staleMinutes?: number; limit?: number } = {},
): Promise<ReconciliationReport> {
  const cutoff = new Date(now.getTime() - (opts.staleMinutes ?? 10) * 60_000);
  const limit = opts.limit ?? 200;
  const report: ReconciliationReport = {
    webhooksReprocessed: 0,
    paymentsSynced: 0,
    paymentsLinked: 0,
    paymentsClosedNotFound: 0,
    paymentsNeedReview: 0,
    refundsResumed: 0,
    refundsRetried: 0,
    refundsRetrySucceeded: 0,
    refundsAwaitingAdminDecision: 0,
    errors: [],
  };
  const fail = (kind: string, id: string, err: unknown, orderId?: string) => report.errors.push({ kind, id, orderId, message: String(err).slice(0, 300) });

  // 1. Webhooks registrados cujo processamento falhou (o provedor pode não reenviar).
  const hooks = await db.paymentWebhookEvent.findMany({
    where: { provider: adapter.id, processedAt: null, providerPaymentId: { not: null }, receivedAt: { lt: new Date(now.getTime() - WEBHOOK_GRACE_MS) } },
    take: limit,
  });
  for (const h of hooks) {
    try {
      const outcome = await syncPaymentFromProvider(db, adapter, h.providerPaymentId!);
      await db.paymentWebhookEvent.update({ where: { id: h.id }, data: { processedAt: new Date(), processingResult: `reconciled:${outcome}`, error: null } });
      report.webhooksReprocessed++;
    } catch (err) {
      fail("webhook", h.id, err);
    }
  }

  // 2. Pagamentos pendentes há muito tempo: o webhook pode ter se perdido.
  const pending = await db.payment.findMany({
    where: { provider: adapter.id, status: "PENDING", providerPaymentId: { not: null }, createdAt: { lt: cutoff } },
    take: limit,
  });
  for (const p of pending) {
    try {
      await syncPaymentFromProvider(db, adapter, p.providerPaymentId!);
      report.paymentsSynced++;
    } catch (err) {
      fail("payment", p.id, err, p.orderId);
    }
  }

  // 3. Pagamentos sem id do provedor: o processo caiu entre criar no provedor e salvar o id.
  const unlinked = await db.payment.findMany({
    where: { provider: adapter.id, status: "PENDING", providerPaymentId: null, method: { not: "FREE" }, createdAt: { lt: cutoff } },
    take: limit,
  });
  for (const p of unlinked) {
    try {
      if (!adapter.findPaymentByReference) {
        // Sem como consultar com segurança: sinaliza para revisão manual, nunca marca como pago/falho às cegas.
        if (p.failureReason !== "PROVIDER_LINK_MISSING") {
          await db.payment.update({ where: { id: p.id }, data: { failureReason: "PROVIDER_LINK_MISSING" } });
        }
        report.paymentsNeedReview++;
        continue;
      }
      const snapshot = await adapter.findPaymentByReference(p.idempotencyKey);
      if (!snapshot) {
        // O provedor confirma que a cobrança nunca existiu.
        await db.payment.updateMany({ where: { id: p.id, status: "PENDING" }, data: { status: "FAILED", failureReason: "provider_create_not_found" } });
        report.paymentsClosedNotFound++;
        continue;
      }
      await db.payment.update({ where: { id: p.id }, data: { providerPaymentId: snapshot.providerPaymentId, providerRawStatus: snapshot.rawStatus } });
      await applyPaymentSnapshot(db, adapter, snapshot);
      report.paymentsLinked++;
    } catch (err) {
      fail("payment-link", p.id, err, p.orderId);
    }
  }

  // 4. Reembolsos parados em REQUESTED/PROCESSING.
  const refunds = await db.refund.findMany({ where: { status: { in: ["REQUESTED", "PROCESSING"] }, updatedAt: { lt: cutoff } }, take: limit });
  for (const r of refunds) {
    try {
      await resumeRefund(db, adapter, r.id);
      report.refundsResumed++;
    } catch (err) {
      fail("refund", r.id, err, r.orderId);
    }
  }

  // 5. Reembolsos FAILED: retentativas limitadas; esgotadas, ficam para decisão do admin.
  const retry = await retryFailedRefunds(db, adapter, now, limit);
  report.refundsRetried = retry.retried;
  report.refundsRetrySucceeded = retry.succeeded;
  report.refundsAwaitingAdminDecision = retry.awaitingAdminDecision;
  report.errors.push(...retry.errors);
  return report;
}

export interface InvariantViolation {
  code: string;
  description: string;
  ids: string[];
}

/**
 * Verifica os invariantes financeiros no banco inteiro. Não corrige nada:
 * qualquer violação é um incidente para análise humana.
 */
export async function checkFinancialInvariants(db: Db): Promise<InvariantViolation[]> {
  const checks: [string, string, Promise<{ id: string }[]>][] = [
    [
      "LEDGER_UNBALANCED",
      "Transação do razão com débitos ≠ créditos",
      db.$queryRaw`SELECT "idempotencyKey" AS id FROM "FinancialLedgerEntry"
        GROUP BY "idempotencyKey"
        HAVING SUM(CASE WHEN direction = 'DEBIT' THEN "amountCents" ELSE -"amountCents" END) <> 0`,
    ],
    [
      "RESERVED_COUNTER_MISMATCH",
      "quantityReserved ≠ soma das reservas ativas",
      db.$queryRaw`SELECT t.id FROM "TicketType" t
        LEFT JOIN (SELECT "ticketTypeId", SUM(quantity) AS q FROM "TicketInventoryReservation" WHERE status = 'ACTIVE' GROUP BY 1) r
          ON r."ticketTypeId" = t.id
        WHERE t."quantityReserved" <> COALESCE(r.q, 0)`,
    ],
    [
      "SOLD_COUNTER_MISMATCH",
      "quantitySold ≠ ingressos emitidos",
      db.$queryRaw`SELECT t.id FROM "TicketType" t
        LEFT JOIN (SELECT "ticketTypeId", COUNT(*) AS c FROM "IssuedTicket" GROUP BY 1) i ON i."ticketTypeId" = t.id
        WHERE t."quantitySold" <> COALESCE(i.c, 0)`,
    ],
    [
      "ACTIVE_RESERVATION_ON_CLOSED_ORDER",
      "Reserva ativa em pedido que não está aguardando pagamento",
      db.$queryRaw`SELECT r.id FROM "TicketInventoryReservation" r JOIN "Order" o ON o.id = r."orderId"
        WHERE r.status = 'ACTIVE' AND o.status <> 'PENDING_PAYMENT'`,
    ],
    [
      "PAID_ORDER_TICKET_COUNT",
      "Pedido pago com quantidade de ingressos diferente dos itens",
      db.$queryRaw`SELECT o.id FROM "Order" o
        JOIN (SELECT "orderId", SUM(quantity) AS q FROM "OrderItem" GROUP BY 1) i ON i."orderId" = o.id
        LEFT JOIN (SELECT "orderId", COUNT(*) AS c FROM "IssuedTicket" GROUP BY 1) t ON t."orderId" = o.id
        WHERE o.status = 'PAID' AND COALESCE(t.c, 0) <> i.q`,
    ],
    [
      "ORDER_TOTALS_MISMATCH",
      "Totais do pedido ≠ soma dos itens (preço, taxa de serviço ou comissão)",
      db.$queryRaw`SELECT o.id FROM "Order" o
        JOIN (SELECT "orderId",
                SUM(("unitPriceCents" + "serviceFeePerUnitCents") * quantity) AS total,
                SUM("serviceFeePerUnitCents" * quantity) AS fee,
                SUM("commissionPerUnitCents" * quantity) AS comm
              FROM "OrderItem" GROUP BY 1) i ON i."orderId" = o.id
        WHERE i.total <> o."totalCents" OR i.fee <> o."serviceFeeCents" OR i.comm <> o."commissionCents"`,
    ],
    [
      "OVER_REFUND",
      "Reembolsos concluídos acima do valor do pedido",
      db.$queryRaw`SELECT o.id FROM "Order" o
        JOIN (SELECT "orderId", SUM("amountCents") AS s FROM "Refund" WHERE status = 'SUCCEEDED' GROUP BY 1) r ON r."orderId" = o.id
        WHERE r.s > o."totalCents"`,
    ],
    [
      "PAID_ORDER_WITHOUT_SALE_ENTRY",
      "Pedido pago sem lançamento de venda no razão",
      db.$queryRaw`SELECT o.id FROM "Order" o
        WHERE o.status IN ('PAID', 'REFUND_PENDING', 'REFUNDED', 'DISPUTED') AND o."totalCents" > 0
          AND NOT EXISTS (SELECT 1 FROM "FinancialLedgerEntry" l WHERE l."idempotencyKey" = 'sale:' || o.id)`,
    ],
    [
      "REVOKED_TICKET_ON_PAID_ORDER",
      "Ingresso revogado em pedido ainda pago (sem reembolso/chargeback)",
      db.$queryRaw`SELECT t.id FROM "IssuedTicket" t JOIN "Order" o ON o.id = t."orderId"
        JOIN "Event" e ON e.id = t."eventId"
        WHERE t.status = 'REVOKED' AND o.status = 'PAID' AND e.status <> 'CANCELLED'`,
    ],
    [
      "REFUND_PENDING_WITHOUT_OPEN_REFUND",
      "Pedido aguardando reembolso sem reembolso em aberto (REQUESTED/PROCESSING/FAILED)",
      db.$queryRaw`SELECT o.id FROM "Order" o
        WHERE o.status = 'REFUND_PENDING'
          AND NOT EXISTS (SELECT 1 FROM "Refund" r WHERE r."orderId" = o.id AND r.status IN ('REQUESTED', 'PROCESSING', 'FAILED'))`,
    ],
    [
      "OPEN_REFUND_ON_PAID_ORDER",
      "Reembolso em aberto em pedido pago (seria reprocessado com os ingressos válidos)",
      db.$queryRaw`SELECT r.id FROM "Refund" r JOIN "Order" o ON o.id = r."orderId"
        WHERE r.status IN ('REQUESTED', 'PROCESSING', 'FAILED') AND o.status = 'PAID'`,
    ],
    [
      "VALID_TICKET_ON_REFUND_PENDING_ORDER",
      "Ingresso válido em pedido aguardando reembolso (entrada e estorno ao mesmo tempo)",
      db.$queryRaw`SELECT t.id FROM "IssuedTicket" t JOIN "Order" o ON o.id = t."orderId"
        WHERE t.status = 'VALID' AND o.status = 'REFUND_PENDING'`,
    ],
    // ── Cupons e links (ADR 0002) ──
    [
      "COUPON_COUNTERS_MISMATCH",
      "Contadores do cupom ≠ pedidos (reservado = pendentes; resgatado = pedidos com ingressos emitidos)",
      // Resgatado conta pedidos com ingresso emitido (nunca apagado): cobre gratuito,
      // pago, tardio, reembolsado e chargeback, e exclui o pagamento tardio sem estoque.
      // Igualdade exata: o uso acima de maxUses (tardio, auditado) não é divergência do contador.
      db.$queryRaw`SELECT c.id FROM "Coupon" c
        LEFT JOIN (SELECT o."couponId",
                     SUM(CASE WHEN o.status = 'PENDING_PAYMENT' THEN 1 ELSE 0 END) AS reserved,
                     SUM(CASE WHEN EXISTS (SELECT 1 FROM "IssuedTicket" t WHERE t."orderId" = o.id) THEN 1 ELSE 0 END) AS redeemed
                   FROM "Order" o WHERE o."couponId" IS NOT NULL GROUP BY 1) x ON x."couponId" = c.id
        WHERE c."timesReserved" <> COALESCE(x.reserved, 0) OR c."timesRedeemed" <> COALESCE(x.redeemed, 0)`,
    ],
    [
      "ORDER_DISCOUNT_MISMATCH",
      "Desconto do pedido ≠ soma dos descontos dos itens",
      db.$queryRaw`SELECT o.id FROM "Order" o
        JOIN (SELECT "orderId", SUM("discountPerUnitCents" * quantity) AS d FROM "OrderItem" GROUP BY 1) i ON i."orderId" = o.id
        WHERE i.d <> o."discountCents"`,
    ],
    [
      "COUPON_TENANT_MISMATCH",
      "Cupom ou link ligado a evento, tipo de ingresso ou cupom de outro evento/organização",
      db.$queryRaw`SELECT o.id FROM "Order" o JOIN "Coupon" c ON c.id = o."couponId"
          WHERE c."eventId" IS NOT NULL AND c."eventId" <> o."eventId"
        UNION ALL
        SELECT o.id FROM "Order" o JOIN "TrackingLink" l ON l.id = o."trackingLinkId"
          WHERE l."eventId" <> o."eventId"
        UNION ALL
        SELECT ct."couponId" || ':' || ct."ticketTypeId" FROM "CouponTicketType" ct
          JOIN "Coupon" c ON c.id = ct."couponId"
          JOIN "TicketType" tt ON tt.id = ct."ticketTypeId"
          JOIN "Event" e ON e.id = tt."eventId"
          WHERE e."organizationId" <> c."organizationId" OR (c."eventId" IS NOT NULL AND tt."eventId" <> c."eventId")
        UNION ALL
        SELECT l.id FROM "TrackingLink" l JOIN "Coupon" c ON c.id = l."couponId"
          WHERE c."organizationId" <> l."organizationId" OR (c."eventId" IS NOT NULL AND c."eventId" <> l."eventId")`,
    ],
  ];
  const results = await Promise.all(checks.map(([, , q]) => q));
  return checks
    .map(([code, description], i) => ({ code, description, ids: results[i].map((r) => String(r.id)) }))
    .filter((v) => v.ids.length > 0);
}
