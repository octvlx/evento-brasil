-- Política de reembolso por evento: prazo após a compra e antecedência mínima.
-- Aditiva: eventos existentes recebem os padrões (7 dias e 48 horas), os mesmos
-- valores que antes vinham de REFUND_WINDOW_DAYS / REFUND_MIN_HOURS_BEFORE_EVENT.

-- AlterTable
ALTER TABLE "Event" ADD COLUMN "refundWindowDays" INTEGER NOT NULL DEFAULT 7,
ADD COLUMN "refundMinHoursBeforeEvent" INTEGER NOT NULL DEFAULT 48;

-- Limites (não modelados pelo Prisma).
ALTER TABLE "Event"
  ADD CONSTRAINT "Event_refund_window_days" CHECK ("refundWindowDays" BETWEEN 0 AND 365),
  ADD CONSTRAINT "Event_refund_min_hours" CHECK ("refundMinHoursBeforeEvent" BETWEEN 0 AND 720);
