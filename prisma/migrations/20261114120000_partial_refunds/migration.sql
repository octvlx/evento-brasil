-- Reembolso parcial por ingresso (só aditivo).
-- IssuedTicket.refundId liga cada ingresso ao reembolso que o cobre; Refund.partial
-- marca reembolsos que cobrem só parte do pedido (o pedido continua PAID).

ALTER TABLE "IssuedTicket" ADD COLUMN "refundId" TEXT;

ALTER TABLE "Refund" ADD COLUMN "partial" BOOLEAN NOT NULL DEFAULT false;

-- Simulador de pagamentos: estornos parciais e idempotência por chave.
ALTER TABLE "SimulatedProviderPayment" ADD COLUMN "refundKeys" TEXT[] DEFAULT ARRAY[]::TEXT[],
ADD COLUMN "refundedCents" INTEGER NOT NULL DEFAULT 0;

CREATE INDEX "IssuedTicket_refundId_idx" ON "IssuedTicket"("refundId");

ALTER TABLE "IssuedTicket" ADD CONSTRAINT "IssuedTicket_refundId_fkey" FOREIGN KEY ("refundId") REFERENCES "Refund"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- Dados existentes: até aqui todo reembolso era integral e um pedido tinha no máximo
-- um reembolso não recusado. Os ingressos de pedidos em reembolso/reembolsados
-- passam a apontar para esse reembolso (a restauração do admin depende disso).
UPDATE "IssuedTicket" t
SET "refundId" = r.id
FROM (
  SELECT DISTINCT ON ("orderId") id, "orderId"
  FROM "Refund"
  WHERE status <> 'REJECTED'
  ORDER BY "orderId", "createdAt" DESC
) r
JOIN "Order" o ON o.id = r."orderId"
WHERE t."orderId" = r."orderId"
  AND o.status IN ('REFUND_PENDING', 'REFUNDED')
  AND t."refundId" IS NULL;
