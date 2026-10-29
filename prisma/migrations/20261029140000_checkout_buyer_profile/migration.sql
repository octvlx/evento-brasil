-- AlterTable
ALTER TABLE "User" ADD COLUMN     "birthDate" DATE,
ADD COLUMN     "cpfEncrypted" TEXT,
ADD COLUMN     "cpfHash" TEXT,
ADD COLUMN     "cpfLast2" VARCHAR(2),
ADD COLUMN     "emailVerifiedAt" TIMESTAMPTZ(3),
ADD COLUMN     "googleSubject" TEXT;

-- AlterTable
ALTER TABLE "Order" ADD COLUMN     "checkoutReviewRequired" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN     "checkoutReviewedAt" TIMESTAMPTZ(3);

-- CreateTable
CREATE TABLE "UserAddress" (
    "userId" TEXT NOT NULL,
    "postalCode" VARCHAR(8) NOT NULL,
    "street" VARCHAR(200) NOT NULL,
    "number" VARCHAR(30) NOT NULL,
    "complement" VARCHAR(200),
    "district" VARCHAR(120) NOT NULL,
    "city" VARCHAR(120) NOT NULL,
    "state" VARCHAR(2) NOT NULL,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "UserAddress_pkey" PRIMARY KEY ("userId")
);

-- CreateTable
CREATE TABLE "EmailVerificationToken" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "tokenHash" TEXT NOT NULL,
    "expiresAt" TIMESTAMPTZ(3) NOT NULL,
    "consumedAt" TIMESTAMPTZ(3),
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "EmailVerificationToken_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "CheckoutDraft" (
    "idempotencyKey" TEXT NOT NULL,
    "id" TEXT NOT NULL,
    "tokenHash" TEXT NOT NULL,
    "userId" TEXT,
    "eventId" TEXT NOT NULL,
    "selection" JSONB NOT NULL,
    "revision" INTEGER NOT NULL DEFAULT 0,
    "expiresAt" TIMESTAMPTZ(3) NOT NULL,
    "orderId" TEXT,
    "reviewHash" TEXT,
    "confirmedAt" TIMESTAMPTZ(3),
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "CheckoutDraft_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "EmailVerificationToken_tokenHash_key" ON "EmailVerificationToken"("tokenHash");

-- CreateIndex
CREATE INDEX "EmailVerificationToken_userId_createdAt_idx" ON "EmailVerificationToken"("userId", "createdAt");

-- CreateIndex
CREATE INDEX "EmailVerificationToken_expiresAt_idx" ON "EmailVerificationToken"("expiresAt");

-- CreateIndex
CREATE UNIQUE INDEX "CheckoutDraft_tokenHash_key" ON "CheckoutDraft"("tokenHash");

-- CreateIndex
CREATE UNIQUE INDEX "CheckoutDraft_orderId_key" ON "CheckoutDraft"("orderId");

-- CreateIndex
CREATE INDEX "CheckoutDraft_userId_updatedAt_idx" ON "CheckoutDraft"("userId", "updatedAt");

-- CreateIndex
CREATE INDEX "CheckoutDraft_expiresAt_idx" ON "CheckoutDraft"("expiresAt");

-- CreateIndex
CREATE UNIQUE INDEX "CheckoutDraft_orderId_userId_eventId_key" ON "CheckoutDraft"("orderId", "userId", "eventId");

-- CreateIndex
CREATE UNIQUE INDEX "User_cpfHash_key" ON "User"("cpfHash");

-- CreateIndex
CREATE UNIQUE INDEX "User_googleSubject_key" ON "User"("googleSubject");

-- CreateIndex
CREATE UNIQUE INDEX "Order_id_userId_eventId_key" ON "Order"("id", "userId", "eventId");

-- AddForeignKey
ALTER TABLE "UserAddress" ADD CONSTRAINT "UserAddress_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "EmailVerificationToken" ADD CONSTRAINT "EmailVerificationToken_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CheckoutDraft" ADD CONSTRAINT "CheckoutDraft_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CheckoutDraft" ADD CONSTRAINT "CheckoutDraft_eventId_fkey" FOREIGN KEY ("eventId") REFERENCES "Event"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CheckoutDraft" ADD CONSTRAINT "CheckoutDraft_orderId_userId_eventId_fkey" FOREIGN KEY ("orderId", "userId", "eventId") REFERENCES "Order"("id", "userId", "eventId") ON DELETE RESTRICT ON UPDATE CASCADE;
-- Application-level encryption and CPF check digits are enforced by buyer-profile service.
-- The database also rejects partial/unencrypted document representations.
ALTER TABLE "User" ADD CONSTRAINT "User_buyer_cpf_complete" CHECK (
  ("cpfEncrypted" IS NULL AND "cpfHash" IS NULL AND "cpfLast2" IS NULL)
  OR ("cpfEncrypted" LIKE 'v1.%' AND "cpfHash" ~ '^[0-9a-f]{64}$' AND "cpfLast2" ~ '^[0-9]{2}$')
);
ALTER TABLE "User" ADD CONSTRAINT "User_birth_date_range" CHECK (
  "birthDate" IS NULL OR ("birthDate" >= DATE '1900-01-01' AND "birthDate" <= CURRENT_DATE)
);
ALTER TABLE "UserAddress" ADD CONSTRAINT "UserAddress_postal_code" CHECK ("postalCode" ~ '^[0-9]{8}$');
ALTER TABLE "UserAddress" ADD CONSTRAINT "UserAddress_state" CHECK (
  "state" IN ('AC','AL','AP','AM','BA','CE','DF','ES','GO','MA','MT','MS','MG','PA','PB','PR','PE','PI','RJ','RN','RS','RO','RR','SC','SP','SE','TO')
);
ALTER TABLE "UserAddress" ADD CONSTRAINT "UserAddress_required_text" CHECK (
  length(btrim("street")) > 0 AND length(btrim("number")) > 0 AND length(btrim("district")) > 0 AND length(btrim("city")) > 0
);
ALTER TABLE "EmailVerificationToken" ADD CONSTRAINT "EmailVerificationToken_hash" CHECK ("tokenHash" ~ '^[0-9a-f]{64}$');
ALTER TABLE "EmailVerificationToken" ADD CONSTRAINT "EmailVerificationToken_expiry" CHECK ("expiresAt" > "createdAt");
ALTER TABLE "CheckoutDraft" ADD CONSTRAINT "CheckoutDraft_hashes" CHECK (
  "tokenHash" ~ '^[0-9a-f]{64}$' AND ("reviewHash" IS NULL OR "reviewHash" ~ '^[0-9a-f]{64}$')
);
ALTER TABLE "CheckoutDraft" ADD CONSTRAINT "CheckoutDraft_revision" CHECK ("revision" >= 0);
ALTER TABLE "CheckoutDraft" ADD CONSTRAINT "CheckoutDraft_selection_object" CHECK (jsonb_typeof("selection") = 'object');
ALTER TABLE "CheckoutDraft" ADD CONSTRAINT "CheckoutDraft_link_requires_owner" CHECK ("orderId" IS NULL OR "userId" IS NOT NULL);

CREATE UNIQUE INDEX "CheckoutDraft_idempotencyKey_key" ON "CheckoutDraft"("idempotencyKey");
