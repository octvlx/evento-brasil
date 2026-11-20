-- Suspensão de evento pelo admin, sem cancelar nem reembolsar: o evento sai da
-- vitrine e das vendas, os ingressos já vendidos continuam valendo e a edição pelo
-- organizador fica travada até a reativação. Ver setEventSuspended (events.ts).
ALTER TABLE "Event" ADD COLUMN "suspendedAt" TIMESTAMPTZ(3);
ALTER TABLE "Event" ADD COLUMN "suspensionReason" TEXT;
ALTER TABLE "Event" ADD COLUMN "suspendedById" TEXT;

-- Suspenso sempre com motivo e autor; reativado limpa os três juntos.
ALTER TABLE "Event" ADD CONSTRAINT "Event_suspension_complete"
  CHECK (("suspendedAt" IS NULL AND "suspensionReason" IS NULL AND "suspendedById" IS NULL)
      OR ("suspendedAt" IS NOT NULL AND "suspensionReason" IS NOT NULL AND length(btrim("suspensionReason")) > 0 AND "suspendedById" IS NOT NULL));
