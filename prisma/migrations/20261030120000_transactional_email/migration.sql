CREATE TABLE "PasswordResetToken" (
 "id" TEXT PRIMARY KEY,"userId" TEXT NOT NULL REFERENCES "User"("id") ON DELETE CASCADE,
 "tokenHash" TEXT NOT NULL UNIQUE CHECK ("tokenHash" ~ '^[0-9a-f]{64}$'),
 "expiresAt" TIMESTAMPTZ(3) NOT NULL,"consumedAt" TIMESTAMPTZ(3),"createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX "PasswordResetToken_userId_createdAt_idx" ON "PasswordResetToken"("userId","createdAt");
CREATE INDEX "PasswordResetToken_expiresAt_idx" ON "PasswordResetToken"("expiresAt");
CREATE TYPE "EmailDeliveryStatus" AS ENUM ('QUEUED','PROCESSING','SENT','FAILED','CANCELLED','UNKNOWN');
CREATE TABLE "EmailOutbox" (
 "id" TEXT PRIMARY KEY,"dedupeKey" TEXT NOT NULL UNIQUE,"template" TEXT NOT NULL,"recipient" TEXT NOT NULL,
 "payloadEncrypted" TEXT,"messageEncrypted" TEXT,"status" "EmailDeliveryStatus" NOT NULL DEFAULT 'QUEUED',
 "provider" TEXT,"providerMessageId" TEXT,"attemptCount" INTEGER NOT NULL DEFAULT 0 CHECK ("attemptCount">=0),
 "firstAttemptAt" TIMESTAMPTZ(3),"nextAttemptAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
 "lockedUntil" TIMESTAMPTZ(3),"leaseToken" TEXT,"expiresAt" TIMESTAMPTZ(3),"sentAt" TIMESTAMPTZ(3),"failedAt" TIMESTAMPTZ(3),"errorCode" TEXT,
 "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,"updatedAt" TIMESTAMPTZ(3) NOT NULL,
 CONSTRAINT "EmailOutbox_encrypted_payload" CHECK (("payloadEncrypted" IS NULL OR "payloadEncrypted" LIKE 'v1.%') AND ("messageEncrypted" IS NULL OR "messageEncrypted" LIKE 'v1.%'))
);
CREATE INDEX "EmailOutbox_status_nextAttemptAt_idx" ON "EmailOutbox"("status","nextAttemptAt");
CREATE INDEX "EmailOutbox_lockedUntil_idx" ON "EmailOutbox"("lockedUntil");
CREATE TABLE "EmailRateLimit" ("key" TEXT PRIMARY KEY,"count" INTEGER NOT NULL DEFAULT 0 CHECK("count">=0),"windowStartedAt" TIMESTAMPTZ(3) NOT NULL);
