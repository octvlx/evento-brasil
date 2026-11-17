-- Carteiras digitais: passes entregues (um por versão do QR) e aparelhos Apple
-- registrados para atualização. Só tabelas novas.

-- CreateEnum
CREATE TYPE "WalletProvider" AS ENUM ('APPLE', 'GOOGLE');

-- CreateEnum
CREATE TYPE "WalletPassState" AS ENUM ('ACTIVE', 'COMPLETED', 'INACTIVE');

-- CreateTable
CREATE TABLE "WalletPass" (
    "id" TEXT NOT NULL,
    "ticketId" TEXT NOT NULL,
    "provider" "WalletProvider" NOT NULL,
    "serial" TEXT NOT NULL,
    "tokenVersion" INTEGER NOT NULL,
    "syncedState" "WalletPassState" NOT NULL DEFAULT 'ACTIVE',
    "changedAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "syncAttempts" INTEGER NOT NULL DEFAULT 0,
    "syncError" TEXT,

    CONSTRAINT "WalletPass_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "AppleWalletRegistration" (
    "id" TEXT NOT NULL,
    "passId" TEXT NOT NULL,
    "deviceLibraryId" TEXT NOT NULL,
    "pushToken" TEXT NOT NULL,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "AppleWalletRegistration_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "WalletPass_ticketId_idx" ON "WalletPass"("ticketId");

-- CreateIndex
CREATE UNIQUE INDEX "WalletPass_provider_serial_key" ON "WalletPass"("provider", "serial");

-- CreateIndex
CREATE INDEX "AppleWalletRegistration_passId_idx" ON "AppleWalletRegistration"("passId");

-- CreateIndex
CREATE UNIQUE INDEX "AppleWalletRegistration_deviceLibraryId_passId_key" ON "AppleWalletRegistration"("deviceLibraryId", "passId");

-- AddForeignKey
ALTER TABLE "WalletPass" ADD CONSTRAINT "WalletPass_ticketId_fkey" FOREIGN KEY ("ticketId") REFERENCES "IssuedTicket"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AppleWalletRegistration" ADD CONSTRAINT "AppleWalletRegistration_passId_fkey" FOREIGN KEY ("passId") REFERENCES "WalletPass"("id") ON DELETE CASCADE ON UPDATE CASCADE;

