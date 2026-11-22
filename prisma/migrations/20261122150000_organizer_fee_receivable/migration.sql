-- Valor fixo não reembolsável com o split do Mercado Pago. O estorno parcial devolve a
-- comissão da plataforma proporcionalmente; a parte do valor fixo que fica na conta do
-- organizador vira saldo devedor (ORGANIZER_RECEIVABLE) e é compensada nas próximas
-- cobranças dele, somada ao marketplace_fee (Payment.feeRecoveryCents).
ALTER TYPE "LedgerAccount" ADD VALUE 'ORGANIZER_RECEIVABLE';

ALTER TABLE "Payment" ADD COLUMN "feeRecoveryCents" INTEGER NOT NULL DEFAULT 0;
ALTER TABLE "Payment" ADD CONSTRAINT "Payment_feeRecoveryCents_range"
  CHECK ("feeRecoveryCents" >= 0 AND "feeRecoveryCents" <= "amountCents");
