-- Transferencia de responsavel (OWNER) da organizacao, com aceite do novo dono.
-- So tabela e tipo novos.
CREATE TYPE "OwnershipTransferStatus" AS ENUM ('PENDING', 'ACCEPTED', 'DECLINED', 'CANCELLED');

CREATE TABLE "OrganizationOwnershipTransfer" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "fromUserId" TEXT NOT NULL,
    "toUserId" TEXT NOT NULL,
    "tokenHash" TEXT NOT NULL,
    "status" "OwnershipTransferStatus" NOT NULL DEFAULT 'PENDING',
    "expiresAt" TIMESTAMPTZ(3) NOT NULL,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "decidedAt" TIMESTAMPTZ(3),

    CONSTRAINT "OrganizationOwnershipTransfer_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "OrganizationOwnershipTransfer_tokenHash_key" ON "OrganizationOwnershipTransfer"("tokenHash");
CREATE INDEX "OrganizationOwnershipTransfer_organizationId_status_idx" ON "OrganizationOwnershipTransfer"("organizationId", "status");
-- No maximo um pedido pendente por organizacao (um novo pedido cancela o anterior).
CREATE UNIQUE INDEX "OrganizationOwnershipTransfer_one_pending" ON "OrganizationOwnershipTransfer"("organizationId") WHERE "status" = 'PENDING';

ALTER TABLE "OrganizationOwnershipTransfer" ADD CONSTRAINT "OrganizationOwnershipTransfer_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "Organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;
