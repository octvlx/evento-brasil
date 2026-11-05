-- AlterTable
ALTER TABLE "ExternalEvent" ADD COLUMN     "coverImageUrl" VARCHAR(500),
ADD COLUMN     "isFeatured" BOOLEAN NOT NULL DEFAULT false;

-- CreateIndex
CREATE INDEX "ExternalEvent_isFeatured_review_startsAt_idx" ON "ExternalEvent"("isFeatured", "review", "startsAt");

