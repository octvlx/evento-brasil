-- Garantias de integridade que não são expressáveis no schema Prisma.

-- Estoque: nunca negativo e nunca acima do total.
ALTER TABLE "TicketType"
  ADD CONSTRAINT "TicketType_price_nonnegative" CHECK ("priceCents" >= 0),
  ADD CONSTRAINT "TicketType_counters_nonnegative" CHECK (
    "quantityTotal" >= 0 AND "quantityReserved" >= 0 AND "quantitySold" >= 0
    AND "quantityRefunded" >= 0 AND "quantityCancelled" >= 0),
  ADD CONSTRAINT "TicketType_no_oversell" CHECK ("quantityReserved" + "quantitySold" <= "quantityTotal"),
  ADD CONSTRAINT "TicketType_refunds_le_sold" CHECK ("quantityRefunded" + "quantityCancelled" <= "quantitySold"),
  ADD CONSTRAINT "TicketType_order_limits" CHECK ("minPerOrder" >= 1 AND "maxPerOrder" >= "minPerOrder");

ALTER TABLE "Event"
  ADD CONSTRAINT "Event_capacity_positive" CHECK ("capacity" > 0),
  ADD CONSTRAINT "Event_time_order" CHECK ("endsAt" > "startsAt" AND "salesEndAt" > "salesStartAt"),
  ADD CONSTRAINT "Event_half_price_quota" CHECK ("halfPriceQuotaBps" IS NULL OR ("halfPriceQuotaBps" BETWEEN 0 AND 10000)),
  ADD CONSTRAINT "Event_age" CHECK ("ageRestriction" BETWEEN 0 AND 21);

ALTER TABLE "TicketInventoryReservation"
  ADD CONSTRAINT "Reservation_quantity_positive" CHECK ("quantity" > 0);

ALTER TABLE "Order"
  ADD CONSTRAINT "Order_amounts_nonnegative" CHECK (
    "subtotalCents" >= 0 AND "serviceFeeCents" >= 0 AND "commissionCents" >= 0
    AND "totalCents" = "subtotalCents" + "serviceFeeCents");

ALTER TABLE "OrderItem"
  ADD CONSTRAINT "OrderItem_amounts" CHECK (
    "quantity" > 0 AND "unitPriceCents" >= 0 AND "commissionPerUnitCents" >= 0 AND "serviceFeePerUnitCents" >= 0);

ALTER TABLE "Payment"
  ADD CONSTRAINT "Payment_amount_nonnegative" CHECK ("amountCents" >= 0);

ALTER TABLE "Refund"
  ADD CONSTRAINT "Refund_amount_nonnegative" CHECK ("amountCents" >= 0);

ALTER TABLE "CommissionRule"
  ADD CONSTRAINT "CommissionRule_bps" CHECK ("percentBps" BETWEEN 0 AND 10000 AND "fixedCentsPerTicket" >= 0),
  ADD CONSTRAINT "CommissionRule_scope_target" CHECK (
    ("scope" = 'PLATFORM' AND "organizationId" IS NULL AND "eventId" IS NULL) OR
    ("scope" = 'ORGANIZATION' AND "organizationId" IS NOT NULL AND "eventId" IS NULL) OR
    ("scope" = 'EVENT' AND "eventId" IS NOT NULL));

ALTER TABLE "FinancialLedgerEntry"
  ADD CONSTRAINT "Ledger_amount_positive" CHECK ("amountCents" > 0);

-- Razão financeiro imutável: somente INSERT.
CREATE OR REPLACE FUNCTION ledger_block_mutation() RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION 'FinancialLedgerEntry é somente inserção (operação % bloqueada)', TG_OP;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER "FinancialLedgerEntry_immutable"
  BEFORE UPDATE OR DELETE ON "FinancialLedgerEntry"
  FOR EACH ROW EXECUTE FUNCTION ledger_block_mutation();

-- Busca textual simples (sem acentos sensíveis) para títulos de eventos.
CREATE INDEX "Event_title_lower_idx" ON "Event" (lower("title"));
