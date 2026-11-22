-- Denúncias de eventos (services/event-reports.ts). Tabela nova: nenhum dado existente muda.
-- CreateEnum
CREATE TYPE "EventReportReason" AS ENUM ('FRAUD', 'MISLEADING', 'INAPPROPRIATE', 'RIGHTS_VIOLATION', 'OTHER');

-- CreateEnum
CREATE TYPE "EventReportStatus" AS ENUM ('OPEN', 'RESOLVED', 'DISMISSED');

-- CreateTable
CREATE TABLE "EventReport" (
    "id" TEXT NOT NULL,
    "eventId" TEXT NOT NULL,
    "reporterId" TEXT NOT NULL,
    "reason" "EventReportReason" NOT NULL,
    "details" VARCHAR(1000),
    "status" "EventReportStatus" NOT NULL DEFAULT 'OPEN',
    "decidedById" TEXT,
    "decidedAt" TIMESTAMPTZ(3),
    "decisionNote" VARCHAR(1000),
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "EventReport_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "EventReport_status_createdAt_idx" ON "EventReport"("status", "createdAt");

-- CreateIndex
CREATE INDEX "EventReport_eventId_status_idx" ON "EventReport"("eventId", "status");

-- CreateIndex
CREATE INDEX "EventReport_reporterId_createdAt_idx" ON "EventReport"("reporterId", "createdAt");

-- AddForeignKey
ALTER TABLE "EventReport" ADD CONSTRAINT "EventReport_eventId_fkey" FOREIGN KEY ("eventId") REFERENCES "Event"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "EventReport" ADD CONSTRAINT "EventReport_reporterId_fkey" FOREIGN KEY ("reporterId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "EventReport" ADD CONSTRAINT "EventReport_decidedById_fkey" FOREIGN KEY ("decidedById") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;


-- Uma denúncia aberta por pessoa e evento (depois de decidida, pode denunciar de novo).
CREATE UNIQUE INDEX "EventReport_one_open_per_reporter" ON "EventReport"("eventId", "reporterId") WHERE "status" = 'OPEN';

-- "Outro motivo" exige descrição; decisão sempre com autor e data; aberta, sem decisão.
ALTER TABLE "EventReport" ADD CONSTRAINT "EventReport_other_needs_details"
  CHECK ("reason" <> 'OTHER' OR ("details" IS NOT NULL AND length(btrim("details")) > 0));
ALTER TABLE "EventReport" ADD CONSTRAINT "EventReport_decision_complete"
  CHECK (("status" = 'OPEN' AND "decidedById" IS NULL AND "decidedAt" IS NULL AND "decisionNote" IS NULL)
      OR ("status" <> 'OPEN' AND "decidedById" IS NOT NULL AND "decidedAt" IS NOT NULL));
-- Procedente sempre com nota (o que foi feito).
ALTER TABLE "EventReport" ADD CONSTRAINT "EventReport_resolved_has_note"
  CHECK ("status" <> 'RESOLVED' OR ("decisionNote" IS NOT NULL AND length(btrim("decisionNote")) > 0));
