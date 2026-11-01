-- CreateTable
CREATE TABLE "MercadoPagoAccount" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "mercadoPagoUserId" TEXT NOT NULL,
    "accessTokenEncrypted" TEXT NOT NULL,
    "refreshTokenEncrypted" TEXT NOT NULL,
    "tokenExpiresAt" TIMESTAMPTZ(3) NOT NULL,
    "connectedAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(3) NOT NULL,
    "revokedAt" TIMESTAMPTZ(3),

    CONSTRAINT "MercadoPagoAccount_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "MercadoPagoAccount_organizationId_key"
ON "MercadoPagoAccount"("organizationId");

-- CreateIndex
CREATE INDEX "MercadoPagoAccount_mercadoPagoUserId_idx"
ON "MercadoPagoAccount"("mercadoPagoUserId");

-- AddForeignKey
ALTER TABLE "MercadoPagoAccount"
ADD CONSTRAINT "MercadoPagoAccount_organizationId_fkey"
FOREIGN KEY ("organizationId")
REFERENCES "Organization"("id")
ON DELETE CASCADE
ON UPDATE CASCADE;
-- CreateTable
CREATE TABLE "MercadoPagoOAuthState" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "actorUserId" TEXT NOT NULL,
    "stateHash" TEXT NOT NULL,
    "expiresAt" TIMESTAMPTZ(3) NOT NULL,
    "consumedAt" TIMESTAMPTZ(3),
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "MercadoPagoOAuthState_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "MercadoPagoOAuthState_stateHash_key"
ON "MercadoPagoOAuthState"("stateHash");

-- CreateIndex
CREATE INDEX "MercadoPagoOAuthState_organizationId_idx"
ON "MercadoPagoOAuthState"("organizationId");

-- CreateIndex
CREATE INDEX "MercadoPagoOAuthState_expiresAt_idx"
ON "MercadoPagoOAuthState"("expiresAt");
