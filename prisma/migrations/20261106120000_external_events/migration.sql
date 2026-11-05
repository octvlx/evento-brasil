-- CreateEnum
CREATE TYPE "ExternalSourceStatus" AS ENUM ('ACTIVE', 'PAUSED', 'NEEDS_AUTHORIZATION');

-- CreateEnum
CREATE TYPE "ExternalEventReview" AS ENUM ('PENDING_REVIEW', 'PUBLISHED', 'HIDDEN');

-- CreateEnum
CREATE TYPE "ExternalEventSourceStatus" AS ENUM ('ACTIVE', 'CANCELLED', 'MISSING');

-- CreateEnum
CREATE TYPE "ExternalPriceStatus" AS ENUM ('UNKNOWN', 'FREE', 'PAID');

-- CreateEnum
CREATE TYPE "ExternalImportRunStatus" AS ENUM ('RUNNING', 'SUCCEEDED', 'PARTIAL', 'FAILED');

-- CreateTable
CREATE TABLE "ExternalSource" (
    "id" TEXT NOT NULL,
    "key" VARCHAR(40) NOT NULL,
    "name" VARCHAR(80) NOT NULL,
    "homeUrl" VARCHAR(300) NOT NULL,
    "status" "ExternalSourceStatus" NOT NULL DEFAULT 'PAUSED',
    "notes" VARCHAR(2000),
    "lastRunAt" TIMESTAMPTZ(3),
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "ExternalSource_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ExternalEvent" (
    "id" TEXT NOT NULL,
    "sourceId" TEXT NOT NULL,
    "sourceEventId" VARCHAR(120) NOT NULL,
    "sourceUrl" VARCHAR(500) NOT NULL,
    "slug" VARCHAR(160) NOT NULL,
    "title" VARCHAR(200) NOT NULL,
    "startsAt" TIMESTAMPTZ(3) NOT NULL,
    "hasTime" BOOLEAN NOT NULL DEFAULT false,
    "timezone" VARCHAR(40) NOT NULL,
    "venueName" VARCHAR(200),
    "cityName" VARCHAR(120),
    "state" CHAR(2),
    "cityId" TEXT,
    "categoryName" VARCHAR(80),
    "priceStatus" "ExternalPriceStatus" NOT NULL DEFAULT 'UNKNOWN',
    "minPriceCents" INTEGER,
    "review" "ExternalEventReview" NOT NULL DEFAULT 'PENDING_REVIEW',
    "sourceStatus" "ExternalEventSourceStatus" NOT NULL DEFAULT 'ACTIVE',
    "contentHash" VARCHAR(64) NOT NULL,
    "possibleDuplicateOf" VARCHAR(200),
    "firstSeenAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "lastSeenAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "lastChangedAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "publishedAt" TIMESTAMPTZ(3),
    "reviewedById" TEXT,
    "viewCount" INTEGER NOT NULL DEFAULT 0,
    "outboundClicks" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "ExternalEvent_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ExternalImportRun" (
    "id" TEXT NOT NULL,
    "sourceId" TEXT NOT NULL,
    "status" "ExternalImportRunStatus" NOT NULL DEFAULT 'RUNNING',
    "trigger" VARCHAR(10) NOT NULL,
    "triggeredById" TEXT,
    "startedAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "finishedAt" TIMESTAMPTZ(3),
    "pagesFetched" INTEGER NOT NULL DEFAULT 0,
    "eventsSeen" INTEGER NOT NULL DEFAULT 0,
    "created" INTEGER NOT NULL DEFAULT 0,
    "updated" INTEGER NOT NULL DEFAULT 0,
    "unchanged" INTEGER NOT NULL DEFAULT 0,
    "failed" INTEGER NOT NULL DEFAULT 0,
    "errors" JSONB NOT NULL DEFAULT '[]',

    CONSTRAINT "ExternalImportRun_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "ExternalSource_key_key" ON "ExternalSource"("key");

-- CreateIndex
CREATE UNIQUE INDEX "ExternalEvent_sourceUrl_key" ON "ExternalEvent"("sourceUrl");

-- CreateIndex
CREATE UNIQUE INDEX "ExternalEvent_slug_key" ON "ExternalEvent"("slug");

-- CreateIndex
CREATE INDEX "ExternalEvent_review_startsAt_idx" ON "ExternalEvent"("review", "startsAt");

-- CreateIndex
CREATE INDEX "ExternalEvent_cityId_review_startsAt_idx" ON "ExternalEvent"("cityId", "review", "startsAt");

-- CreateIndex
CREATE UNIQUE INDEX "ExternalEvent_sourceId_sourceEventId_key" ON "ExternalEvent"("sourceId", "sourceEventId");

-- CreateIndex
CREATE INDEX "ExternalImportRun_sourceId_startedAt_idx" ON "ExternalImportRun"("sourceId", "startedAt");

-- AddForeignKey
ALTER TABLE "ExternalEvent" ADD CONSTRAINT "ExternalEvent_sourceId_fkey" FOREIGN KEY ("sourceId") REFERENCES "ExternalSource"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ExternalEvent" ADD CONSTRAINT "ExternalEvent_cityId_fkey" FOREIGN KEY ("cityId") REFERENCES "City"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ExternalImportRun" ADD CONSTRAINT "ExternalImportRun_sourceId_fkey" FOREIGN KEY ("sourceId") REFERENCES "ExternalSource"("id") ON DELETE RESTRICT ON UPDATE CASCADE;


-- Integridade escrita à mão (Prisma não gera CHECK).
-- Preço: gratuito só com 0 (ou sem valor); preço informado sempre positivo; ausente nunca é gratuito.
ALTER TABLE "ExternalEvent" ADD CONSTRAINT "ExternalEvent_price_check" CHECK (
  ("priceStatus" = 'FREE' AND ("minPriceCents" IS NULL OR "minPriceCents" = 0))
  OR ("priceStatus" = 'PAID' AND ("minPriceCents" IS NULL OR "minPriceCents" > 0))
  OR ("priceStatus" = 'UNKNOWN' AND "minPriceCents" IS NULL)
);
ALTER TABLE "ExternalEvent" ADD CONSTRAINT "ExternalEvent_sourceUrl_https_check" CHECK ("sourceUrl" LIKE 'https://%');
ALTER TABLE "ExternalEvent" ADD CONSTRAINT "ExternalEvent_state_check" CHECK ("state" IS NULL OR "state" ~ '^[A-Z]{2}$');

-- Fontes conhecidas. Nenhuma coleta fica ativa por padrão: o admin liga a fonte viável.
INSERT INTO "ExternalSource" ("id", "key", "name", "homeUrl", "status", "notes", "updatedAt") VALUES
  ('extsrc_duoticket', 'duoticket', 'Duoticket', 'https://duoticket.com.br/', 'PAUSED',
   'Viável (verificado em 05/11/2026): robots.txt permite (exceto /validador/); termos proíbem copiar marcas, logotipos, interface e software, não dados factuais de eventos. Coleta só de título, data, local, cidade/UF e URL; sem imagem, descrição ou preço (preço não está no HTML público).',
   NOW()),
  ('extsrc_sympla', 'sympla', 'Sympla', 'https://www.sympla.com.br/', 'NEEDS_AUTHORIZATION',
   'Depende de autorização: a API oficial é licenciada para integrar a aplicação do próprio produtor (token por conta), não para catálogo de terceiros; a divulgação de eventos de terceiros é feita pelo Programa de Afiliados (Buzzlead), com cadastro e campanhas definidas pelos produtores. Sem coleta de páginas.',
   NOW()),
  ('extsrc_q2', 'q2ingressos', 'Q2 Ingressos', 'https://q2ingressos.com.br/', 'NEEDS_AUTHORIZATION',
   'Depende de autorização: o site é um app em JavaScript com fila de acesso (queue-it); a lista de eventos só existe via API interna do próprio site e os termos não são acessíveis sem executar o app. Sem API pública ou feed conhecidos.',
   NOW())
ON CONFLICT ("key") DO NOTHING;
