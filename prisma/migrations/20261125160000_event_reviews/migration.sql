-- Avaliação pós-evento. Só acrescenta: a tabela "EventReview" (com CHECKs) e a coluna
-- anulável "Event"."reviewInviteSentAt"; nenhuma linha existente muda.

-- AlterTable
ALTER TABLE "Event" ADD COLUMN     "reviewInviteSentAt" TIMESTAMPTZ(3);

-- CreateTable
CREATE TABLE "EventReview" (
    "id" TEXT NOT NULL,
    "eventId" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "rating" INTEGER NOT NULL,
    "comment" TEXT,
    "hiddenAt" TIMESTAMPTZ(3),
    "hiddenById" TEXT,
    "hiddenReason" TEXT,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "EventReview_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "EventReview_organizationId_createdAt_idx" ON "EventReview"("organizationId", "createdAt");

-- CreateIndex
CREATE INDEX "EventReview_eventId_createdAt_idx" ON "EventReview"("eventId", "createdAt");

-- CreateIndex
CREATE INDEX "EventReview_userId_idx" ON "EventReview"("userId");

-- CreateIndex
CREATE INDEX "EventReview_hiddenById_idx" ON "EventReview"("hiddenById");

-- CreateIndex
CREATE UNIQUE INDEX "EventReview_eventId_userId_key" ON "EventReview"("eventId", "userId");

-- AddForeignKey
ALTER TABLE "EventReview" ADD CONSTRAINT "EventReview_eventId_fkey" FOREIGN KEY ("eventId") REFERENCES "Event"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "EventReview" ADD CONSTRAINT "EventReview_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "Organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "EventReview" ADD CONSTRAINT "EventReview_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "EventReview" ADD CONSTRAINT "EventReview_hiddenById_fkey" FOREIGN KEY ("hiddenById") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;


-- Nota de 1 a 5; comentário até 1000 caracteres; ocultação com data e motivo juntos.
ALTER TABLE "EventReview" ADD CONSTRAINT "EventReview_rating_range" CHECK ("rating" BETWEEN 1 AND 5);
ALTER TABLE "EventReview" ADD CONSTRAINT "EventReview_comment_length" CHECK ("comment" IS NULL OR char_length("comment") <= 1000);
ALTER TABLE "EventReview" ADD CONSTRAINT "EventReview_hidden_complete" CHECK (("hiddenAt" IS NULL) = ("hiddenReason" IS NULL));
