-- Verificação em duas etapas (TOTP) para contas privilegiadas. Só adiciona
-- colunas opcionais, colunas com padrão e uma tabela; não altera dados existentes.
ALTER TABLE "User"
    ADD COLUMN "totpSecretEncrypted" TEXT,
    ADD COLUMN "totpEnabledAt" TIMESTAMPTZ(3),
    ADD COLUMN "totpLastStep" INTEGER,
    ADD COLUMN "totpPendingSecretEncrypted" TEXT,
    ADD COLUMN "totpPendingAt" TIMESTAMPTZ(3),
    ADD CONSTRAINT "User_totp_secret_encrypted" CHECK (
        ("totpSecretEncrypted" IS NULL OR "totpSecretEncrypted" LIKE 'v1.%')
        AND ("totpPendingSecretEncrypted" IS NULL OR "totpPendingSecretEncrypted" LIKE 'v1.%')
    ),
    ADD CONSTRAINT "User_totp_enabled_has_secret" CHECK ("totpEnabledAt" IS NULL OR "totpSecretEncrypted" IS NOT NULL);

ALTER TABLE "Session"
    ADD COLUMN "mfaPending" BOOLEAN NOT NULL DEFAULT false,
    ADD COLUMN "mfaAttempts" INTEGER NOT NULL DEFAULT 0 CHECK ("mfaAttempts" >= 0);

CREATE TABLE "TotpRecoveryCode" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "codeHash" TEXT NOT NULL CHECK ("codeHash" ~ '^[0-9a-f]{64}$'),
    "usedAt" TIMESTAMPTZ(3),
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "TotpRecoveryCode_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "TotpRecoveryCode_codeHash_key" ON "TotpRecoveryCode"("codeHash");
CREATE INDEX "TotpRecoveryCode_userId_idx" ON "TotpRecoveryCode"("userId");

ALTER TABLE "TotpRecoveryCode"
    ADD CONSTRAINT "TotpRecoveryCode_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
