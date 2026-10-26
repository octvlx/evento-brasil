/*
  Warnings:

  - The `processingFeeBearer` column on the `CommissionRule` table would be dropped and recreated. This will lead to data loss if there is data in the column.

*/
-- CreateEnum
CREATE TYPE "ProcessingFeeBearer" AS ENUM ('ORGANIZER', 'PLATFORM');

-- AlterTable
ALTER TABLE "CommissionRule" DROP COLUMN "processingFeeBearer",
ADD COLUMN     "processingFeeBearer" "ProcessingFeeBearer" NOT NULL DEFAULT 'ORGANIZER';
