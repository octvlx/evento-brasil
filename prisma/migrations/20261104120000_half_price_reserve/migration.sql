-- Reserva automática da cota legal de meia-entrada (L7c).
-- Aditiva: um enum e três colunas em "Event". Eventos existentes ficam no regime
-- FEDERAL (o padrão legal) e sem marcador de auditoria do cron. Não toca em dados.
-- O CHECK "Event_half_price_quota" (0–10000) continua valendo para halfPriceQuotaBps.

-- CreateEnum
CREATE TYPE "HalfPriceRegime" AS ENUM ('FEDERAL', 'NOT_SUBJECT');

-- AlterTable
ALTER TABLE "Event" ADD COLUMN "halfPriceRegime" "HalfPriceRegime" NOT NULL DEFAULT 'FEDERAL',
ADD COLUMN "halfPriceRegimeNote" TEXT,
ADD COLUMN "halfPriceReleaseAuditedFor" TIMESTAMPTZ(3);
