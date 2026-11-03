-- Limite de tentativas no banco (compartilhado entre instâncias e reinícios).
-- Só adiciona uma tabela; não toca em dados existentes.
CREATE TABLE "RateLimitBucket" (
    "key" TEXT NOT NULL CHECK ("key" ~ '^[0-9a-f]{64}$'),
    "count" INTEGER NOT NULL DEFAULT 0 CHECK ("count" >= 0),
    "resetAt" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "RateLimitBucket_pkey" PRIMARY KEY ("key")
);

CREATE INDEX "RateLimitBucket_resetAt_idx" ON "RateLimitBucket"("resetAt");
