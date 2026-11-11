-- Divergências do check-in offline (só aditivo).
CREATE TYPE "OfflineDivergence" AS ENUM ('ADMITTED_BUT_REJECTED', 'REFUSED_BUT_VALID');

ALTER TABLE "TicketCheckin" ADD COLUMN "offlineLocalResult" "CheckinResult",
ADD COLUMN "divergence" "OfflineDivergence";

CREATE INDEX "TicketCheckin_eventId_divergence_idx" ON "TicketCheckin"("eventId", "divergence");
