-- Additive: existing accounts remain usable and are never marked verified implicitly.
ALTER TABLE "User" ADD COLUMN "phoneVerifiedAt" TIMESTAMPTZ(3);

CREATE TABLE "PhoneVerificationChallenge" (
    "id" TEXT NOT NULL,
    "tokenHash" TEXT NOT NULL,
    "email" TEXT NOT NULL,
    "phone" TEXT NOT NULL,
    "clientKeyHash" TEXT NOT NULL,
    "providerVerificationSid" TEXT,
    "expiresAt" TIMESTAMPTZ(3) NOT NULL,
    "verifiedAt" TIMESTAMPTZ(3),
    "consumedAt" TIMESTAMPTZ(3),
    "sendCount" INTEGER NOT NULL DEFAULT 0,
    "checkCount" INTEGER NOT NULL DEFAULT 0,
    "lastSentAt" TIMESTAMPTZ(3),
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(3) NOT NULL,
    CONSTRAINT "PhoneVerificationChallenge_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "PhoneVerificationChallenge_phone_e164" CHECK ("phone" ~ '^\+[1-9][0-9]{7,14}$'),
    CONSTRAINT "PhoneVerificationChallenge_token_hash" CHECK ("tokenHash" ~ '^[0-9a-f]{64}$'),
    CONSTRAINT "PhoneVerificationChallenge_client_key_hash" CHECK ("clientKeyHash" ~ '^[0-9a-f]{64}$'),
    CONSTRAINT "PhoneVerificationChallenge_nonnegative_counters" CHECK ("sendCount" >= 0 AND "checkCount" >= 0),
    CONSTRAINT "PhoneVerificationChallenge_consumed_requires_verified" CHECK ("consumedAt" IS NULL OR "verifiedAt" IS NOT NULL)
);

CREATE UNIQUE INDEX "PhoneVerificationChallenge_tokenHash_key" ON "PhoneVerificationChallenge"("tokenHash");
CREATE UNIQUE INDEX "PhoneVerificationChallenge_providerVerificationSid_key" ON "PhoneVerificationChallenge"("providerVerificationSid");
CREATE INDEX "PhoneVerificationChallenge_phone_createdAt_idx" ON "PhoneVerificationChallenge"("phone", "createdAt");
CREATE INDEX "PhoneVerificationChallenge_clientKeyHash_createdAt_idx" ON "PhoneVerificationChallenge"("clientKeyHash", "createdAt");
CREATE INDEX "PhoneVerificationChallenge_expiresAt_idx" ON "PhoneVerificationChallenge"("expiresAt");
