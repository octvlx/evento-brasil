-- ADR 0003 (Fase 2 / S1 do plano de conformidade ao Decreto nº 13.108/2026):
-- transferência de titularidade (R6), alterações de evento (R8), pedidos de
-- cancelamento com protocolo (R5), termos versionados e aceites (R10) e limite por
-- conta por evento (R4).
-- Parte gerada por `prisma migrate diff` (sem DROP); IssuedTicket.holderUserId
-- ajustado à mão (expandir → preencher → NOT NULL). CHECKs, índices únicos
-- parciais e gatilhos no fim, escritos à mão (o Prisma não os modela).
-- Decisões jurídicas D1–D8 não são fixadas aqui: prazos e regras ficam no serviço.

-- CreateEnum
CREATE TYPE "TicketTransferStatus" AS ENUM ('PENDING', 'ACCEPTED', 'CANCELLED', 'EXPIRED');

-- CreateEnum
CREATE TYPE "TicketTransferInitiator" AS ENUM ('HOLDER', 'ADMIN');

-- CreateEnum
CREATE TYPE "CancellationRequestStatus" AS ENUM ('OPEN', 'APPROVED', 'REJECTED', 'WITHDRAWN');

-- CreateEnum
CREATE TYPE "TermsKind" AS ENUM ('BUYER', 'ORGANIZER', 'PRIVACY');

-- CreateEnum
CREATE TYPE "TermsAcceptanceContext" AS ENUM ('SIGNUP', 'CHECKOUT', 'ORGANIZER_SIGNUP', 'REACCEPT');

-- AlterEnum
ALTER TYPE "RefundReason" ADD VALUE 'EVENT_CHANGED';

-- AlterTable
ALTER TABLE "Event" ADD COLUMN     "maxTicketsPerAccount" INTEGER;

-- AlterTable: titular atual. Backfill = comprador do pedido (hoje igual a IssuedTicket.userId).
ALTER TABLE "IssuedTicket" ADD COLUMN "holderUserId" TEXT;
UPDATE "IssuedTicket" t SET "holderUserId" = o."userId" FROM "Order" o WHERE o."id" = t."orderId";
ALTER TABLE "IssuedTicket" ALTER COLUMN "holderUserId" SET NOT NULL;

-- Sem valor no INSERT (o Prisma omite a coluna: @default(dbgenerated())), o titular é o
-- comprador. Gatilho BEFORE: roda antes da checagem de NOT NULL.
CREATE OR REPLACE FUNCTION issued_ticket_default_holder() RETURNS trigger AS $$
BEGIN
  IF NEW."holderUserId" IS NULL THEN
    NEW."holderUserId" := NEW."userId";
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER "IssuedTicket_default_holder"
  BEFORE INSERT ON "IssuedTicket"
  FOR EACH ROW EXECUTE FUNCTION issued_ticket_default_holder();

-- AlterTable
ALTER TABLE "Refund" ADD COLUMN     "cancellationRequestId" TEXT,
ADD COLUMN     "eventChangeId" TEXT;

-- CreateTable
CREATE TABLE "TicketTransfer" (
    "id" TEXT NOT NULL,
    "ticketId" TEXT NOT NULL,
    "eventId" TEXT NOT NULL,
    "initiatedBy" "TicketTransferInitiator" NOT NULL DEFAULT 'HOLDER',
    "fromUserId" TEXT NOT NULL,
    "fromHolderName" VARCHAR(200) NOT NULL,
    "fromHolderEmail" VARCHAR(254) NOT NULL,
    "toUserId" TEXT,
    "toEmail" VARCHAR(254) NOT NULL,
    "toHolderName" VARCHAR(200),
    "status" "TicketTransferStatus" NOT NULL DEFAULT 'PENDING',
    "tokenHash" CHAR(64),
    "previousTokenHash" CHAR(64),
    "reversesTransferId" TEXT,
    "reason" VARCHAR(2000),
    "createdById" TEXT NOT NULL,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "expiresAt" TIMESTAMPTZ(3),
    "decidedAt" TIMESTAMPTZ(3),
    "decidedById" TEXT,
    "decisionReason" VARCHAR(500),
    "requestIp" VARCHAR(64),
    "requestUserAgent" VARCHAR(512),
    "decisionIp" VARCHAR(64),
    "decisionUserAgent" VARCHAR(512),

    CONSTRAINT "TicketTransfer_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "EventChange" (
    "id" TEXT NOT NULL,
    "eventId" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "actorUserId" TEXT,
    "changedFields" TEXT[],
    "before" JSONB NOT NULL,
    "after" JSONB NOT NULL,
    "reason" VARCHAR(2000) NOT NULL,
    "relevant" BOOLEAN,
    "refundUntil" TIMESTAMPTZ(3),
    "extendsChangeId" TEXT,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "EventChange_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "CancellationRequest" (
    "id" TEXT NOT NULL,
    "protocol" VARCHAR(32) NOT NULL,
    "orderId" TEXT NOT NULL,
    "eventId" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "requestedById" TEXT NOT NULL,
    "reason" VARCHAR(2000) NOT NULL,
    "status" "CancellationRequestStatus" NOT NULL DEFAULT 'OPEN',
    "respondBy" TIMESTAMPTZ(3),
    "autoEligibleAtRequest" BOOLEAN,
    "assignedToId" TEXT,
    "assignedAt" TIMESTAMPTZ(3),
    "decisionNote" VARCHAR(2000),
    "decidedById" TEXT,
    "decidedAt" TIMESTAMPTZ(3),
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "CancellationRequest_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "TermsVersion" (
    "id" TEXT NOT NULL,
    "kind" "TermsKind" NOT NULL,
    "version" VARCHAR(32) NOT NULL,
    "textHash" CHAR(64) NOT NULL,
    "documentPath" VARCHAR(200),
    "isDraft" BOOLEAN NOT NULL DEFAULT true,
    "publishedAt" TIMESTAMPTZ(3) NOT NULL,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "TermsVersion_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "TermsAcceptance" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "termsVersionId" TEXT NOT NULL,
    "context" "TermsAcceptanceContext" NOT NULL,
    "organizationId" TEXT,
    "orderId" TEXT,
    "acceptedAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "ip" VARCHAR(64),
    "userAgent" VARCHAR(512),

    CONSTRAINT "TermsAcceptance_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "TicketTransfer_tokenHash_key" ON "TicketTransfer"("tokenHash");

-- CreateIndex
CREATE UNIQUE INDEX "TicketTransfer_reversesTransferId_key" ON "TicketTransfer"("reversesTransferId");

-- CreateIndex
CREATE INDEX "TicketTransfer_ticketId_createdAt_idx" ON "TicketTransfer"("ticketId", "createdAt");

-- CreateIndex
CREATE INDEX "TicketTransfer_eventId_createdAt_idx" ON "TicketTransfer"("eventId", "createdAt");

-- CreateIndex
CREATE INDEX "TicketTransfer_fromUserId_createdAt_idx" ON "TicketTransfer"("fromUserId", "createdAt");

-- CreateIndex
CREATE INDEX "TicketTransfer_toUserId_createdAt_idx" ON "TicketTransfer"("toUserId", "createdAt");

-- CreateIndex
CREATE INDEX "TicketTransfer_toEmail_status_idx" ON "TicketTransfer"("toEmail", "status");

-- CreateIndex
CREATE INDEX "TicketTransfer_status_expiresAt_idx" ON "TicketTransfer"("status", "expiresAt");

-- CreateIndex
CREATE INDEX "EventChange_eventId_createdAt_idx" ON "EventChange"("eventId", "createdAt");

-- CreateIndex
CREATE INDEX "EventChange_eventId_refundUntil_idx" ON "EventChange"("eventId", "refundUntil");

-- CreateIndex
CREATE INDEX "EventChange_organizationId_createdAt_idx" ON "EventChange"("organizationId", "createdAt");

-- CreateIndex
CREATE INDEX "EventChange_refundUntil_idx" ON "EventChange"("refundUntil");

-- CreateIndex
CREATE INDEX "EventChange_extendsChangeId_idx" ON "EventChange"("extendsChangeId");

-- CreateIndex
CREATE UNIQUE INDEX "CancellationRequest_protocol_key" ON "CancellationRequest"("protocol");

-- CreateIndex
CREATE INDEX "CancellationRequest_status_createdAt_idx" ON "CancellationRequest"("status", "createdAt");

-- CreateIndex
CREATE INDEX "CancellationRequest_status_respondBy_idx" ON "CancellationRequest"("status", "respondBy");

-- CreateIndex
CREATE INDEX "CancellationRequest_eventId_status_idx" ON "CancellationRequest"("eventId", "status");

-- CreateIndex
CREATE INDEX "CancellationRequest_organizationId_status_createdAt_idx" ON "CancellationRequest"("organizationId", "status", "createdAt");

-- CreateIndex
CREATE INDEX "CancellationRequest_orderId_idx" ON "CancellationRequest"("orderId");

-- CreateIndex
CREATE INDEX "CancellationRequest_requestedById_createdAt_idx" ON "CancellationRequest"("requestedById", "createdAt");

-- CreateIndex
CREATE INDEX "TermsVersion_kind_publishedAt_idx" ON "TermsVersion"("kind", "publishedAt");

-- CreateIndex
CREATE UNIQUE INDEX "TermsVersion_kind_version_key" ON "TermsVersion"("kind", "version");

-- CreateIndex
CREATE INDEX "TermsAcceptance_userId_termsVersionId_idx" ON "TermsAcceptance"("userId", "termsVersionId");

-- CreateIndex
CREATE INDEX "TermsAcceptance_termsVersionId_idx" ON "TermsAcceptance"("termsVersionId");

-- CreateIndex
CREATE INDEX "TermsAcceptance_organizationId_idx" ON "TermsAcceptance"("organizationId");

-- CreateIndex
CREATE INDEX "TermsAcceptance_orderId_idx" ON "TermsAcceptance"("orderId");

-- CreateIndex
CREATE INDEX "IssuedTicket_holderUserId_issuedAt_idx" ON "IssuedTicket"("holderUserId", "issuedAt");

-- CreateIndex
CREATE INDEX "IssuedTicket_eventId_holderUserId_idx" ON "IssuedTicket"("eventId", "holderUserId");

-- CreateIndex
CREATE INDEX "IssuedTicket_eventId_userId_idx" ON "IssuedTicket"("eventId", "userId");

-- CreateIndex
CREATE INDEX "Order_userId_eventId_status_idx" ON "Order"("userId", "eventId", "status");

-- CreateIndex
CREATE INDEX "Refund_eventChangeId_idx" ON "Refund"("eventChangeId");

-- CreateIndex
CREATE INDEX "Refund_cancellationRequestId_idx" ON "Refund"("cancellationRequestId");

-- AddForeignKey
ALTER TABLE "IssuedTicket" ADD CONSTRAINT "IssuedTicket_holderUserId_fkey" FOREIGN KEY ("holderUserId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Refund" ADD CONSTRAINT "Refund_eventChangeId_fkey" FOREIGN KEY ("eventChangeId") REFERENCES "EventChange"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Refund" ADD CONSTRAINT "Refund_cancellationRequestId_fkey" FOREIGN KEY ("cancellationRequestId") REFERENCES "CancellationRequest"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "TicketTransfer" ADD CONSTRAINT "TicketTransfer_ticketId_fkey" FOREIGN KEY ("ticketId") REFERENCES "IssuedTicket"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "TicketTransfer" ADD CONSTRAINT "TicketTransfer_eventId_fkey" FOREIGN KEY ("eventId") REFERENCES "Event"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "TicketTransfer" ADD CONSTRAINT "TicketTransfer_fromUserId_fkey" FOREIGN KEY ("fromUserId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "TicketTransfer" ADD CONSTRAINT "TicketTransfer_toUserId_fkey" FOREIGN KEY ("toUserId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "TicketTransfer" ADD CONSTRAINT "TicketTransfer_createdById_fkey" FOREIGN KEY ("createdById") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "TicketTransfer" ADD CONSTRAINT "TicketTransfer_decidedById_fkey" FOREIGN KEY ("decidedById") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "TicketTransfer" ADD CONSTRAINT "TicketTransfer_reversesTransferId_fkey" FOREIGN KEY ("reversesTransferId") REFERENCES "TicketTransfer"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "EventChange" ADD CONSTRAINT "EventChange_eventId_organizationId_fkey" FOREIGN KEY ("eventId", "organizationId") REFERENCES "Event"("id", "organizationId") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "EventChange" ADD CONSTRAINT "EventChange_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "Organization"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "EventChange" ADD CONSTRAINT "EventChange_actorUserId_fkey" FOREIGN KEY ("actorUserId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "EventChange" ADD CONSTRAINT "EventChange_extendsChangeId_fkey" FOREIGN KEY ("extendsChangeId") REFERENCES "EventChange"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CancellationRequest" ADD CONSTRAINT "CancellationRequest_orderId_fkey" FOREIGN KEY ("orderId") REFERENCES "Order"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CancellationRequest" ADD CONSTRAINT "CancellationRequest_eventId_organizationId_fkey" FOREIGN KEY ("eventId", "organizationId") REFERENCES "Event"("id", "organizationId") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CancellationRequest" ADD CONSTRAINT "CancellationRequest_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "Organization"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CancellationRequest" ADD CONSTRAINT "CancellationRequest_requestedById_fkey" FOREIGN KEY ("requestedById") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CancellationRequest" ADD CONSTRAINT "CancellationRequest_assignedToId_fkey" FOREIGN KEY ("assignedToId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CancellationRequest" ADD CONSTRAINT "CancellationRequest_decidedById_fkey" FOREIGN KEY ("decidedById") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "TermsAcceptance" ADD CONSTRAINT "TermsAcceptance_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "TermsAcceptance" ADD CONSTRAINT "TermsAcceptance_termsVersionId_fkey" FOREIGN KEY ("termsVersionId") REFERENCES "TermsVersion"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "TermsAcceptance" ADD CONSTRAINT "TermsAcceptance_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "Organization"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "TermsAcceptance" ADD CONSTRAINT "TermsAcceptance_orderId_fkey" FOREIGN KEY ("orderId") REFERENCES "Order"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- ───────────── Escrito à mão: CHECKs, índices parciais e gatilhos ─────────────

-- Event: limite por conta (R4). Nulo = sem limite.
ALTER TABLE "Event" ADD CONSTRAINT "Event_max_tickets_per_account"
  CHECK ("maxTicketsPerAccount" IS NULL OR "maxTicketsPerAccount" > 0);

-- Refund: reembolso por alteração de evento aponta a alteração, e só ele.
-- Compara como texto: o valor novo do enum não pode ser usado na mesma transação.
ALTER TABLE "Refund" ADD CONSTRAINT "Refund_event_change_link"
  CHECK (("reason"::text = 'EVENT_CHANGED') = ("eventChangeId" IS NOT NULL));

-- TicketTransfer (R6).
ALTER TABLE "TicketTransfer"
  ADD CONSTRAINT "TicketTransfer_decision_state"
    CHECK (("status" = 'PENDING') = ("decidedAt" IS NULL)),
  ADD CONSTRAINT "TicketTransfer_accepted_recipient"
    CHECK ("status" <> 'ACCEPTED' OR ("toUserId" IS NOT NULL AND "toHolderName" IS NOT NULL)),
  ADD CONSTRAINT "TicketTransfer_distinct_parties"
    CHECK ("toUserId" IS NULL OR "toUserId" <> "fromUserId"),
  ADD CONSTRAINT "TicketTransfer_to_email_lower"
    CHECK ("toEmail" = lower("toEmail")),
  ADD CONSTRAINT "TicketTransfer_hash_format"
    CHECK (("tokenHash" IS NULL OR "tokenHash" ~ '^[0-9a-f]{64}$')
       AND ("previousTokenHash" IS NULL OR "previousTokenHash" ~ '^[0-9a-f]{64}$')),
  ADD CONSTRAINT "TicketTransfer_previous_token_on_accept"
    CHECK ("previousTokenHash" IS NULL OR "status" = 'ACCEPTED'),
  -- Pedido do titular: token de aceite, validade e autor = remetente.
  ADD CONSTRAINT "TicketTransfer_holder_request"
    CHECK ("initiatedBy" <> 'HOLDER' OR (
      "tokenHash" IS NOT NULL AND "expiresAt" IS NOT NULL AND "expiresAt" > "createdAt"
      AND "createdById" = "fromUserId" AND "reversesTransferId" IS NULL)),
  -- Ação do admin (reversão por fraude): sem token, nasce decidida, com motivo.
  ADD CONSTRAINT "TicketTransfer_admin_action"
    CHECK ("initiatedBy" <> 'ADMIN' OR (
      "tokenHash" IS NULL AND "status" <> 'PENDING'
      AND "reason" IS NOT NULL AND length(btrim("reason")) > 0));

-- No máximo uma transferência pendente por ingresso.
CREATE UNIQUE INDEX "TicketTransfer_one_pending_per_ticket"
  ON "TicketTransfer" ("ticketId") WHERE "status" = 'PENDING';

-- Histórico ≥ 2 anos: sem DELETE; UPDATE só para decidir uma pendente, sem mexer nos
-- dados do pedido. Depois de decidida, a linha é imutável. TRUNCATE não é afetado.
CREATE OR REPLACE FUNCTION ticket_transfer_guard() RETURNS trigger AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'TicketTransfer é histórico (DELETE bloqueado)';
  END IF;
  IF OLD."status" <> 'PENDING' THEN
    RAISE EXCEPTION 'TicketTransfer % já decidida (%): linha imutável', OLD."id", OLD."status";
  END IF;
  IF NEW."status" = 'PENDING' THEN
    RAISE EXCEPTION 'TicketTransfer %: UPDATE só para decidir (PENDING → ACCEPTED/CANCELLED/EXPIRED)', OLD."id";
  END IF;
  IF (NEW."id", NEW."ticketId", NEW."eventId", NEW."initiatedBy", NEW."fromUserId",
      NEW."fromHolderName", NEW."fromHolderEmail", NEW."toEmail", NEW."tokenHash",
      NEW."reversesTransferId", NEW."reason", NEW."createdById", NEW."createdAt",
      NEW."expiresAt", NEW."requestIp", NEW."requestUserAgent")
     IS DISTINCT FROM
     (OLD."id", OLD."ticketId", OLD."eventId", OLD."initiatedBy", OLD."fromUserId",
      OLD."fromHolderName", OLD."fromHolderEmail", OLD."toEmail", OLD."tokenHash",
      OLD."reversesTransferId", OLD."reason", OLD."createdById", OLD."createdAt",
      OLD."expiresAt", OLD."requestIp", OLD."requestUserAgent") THEN
    RAISE EXCEPTION 'TicketTransfer %: os dados do pedido não mudam', OLD."id";
  END IF;
  IF OLD."toUserId" IS NOT NULL AND NEW."toUserId" IS DISTINCT FROM OLD."toUserId" THEN
    RAISE EXCEPTION 'TicketTransfer %: destinatário já definido', OLD."id";
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER "TicketTransfer_append_only"
  BEFORE UPDATE OR DELETE ON "TicketTransfer"
  FOR EACH ROW EXECUTE FUNCTION ticket_transfer_guard();

-- EventChange (R8).
ALTER TABLE "EventChange"
  ADD CONSTRAINT "EventChange_reason_present"
    CHECK (length(btrim("reason")) > 0),
  ADD CONSTRAINT "EventChange_changed_fields_present"
    CHECK ("changedFields" IS NOT NULL),
  ADD CONSTRAINT "EventChange_refund_window"
    CHECK ("refundUntil" IS NULL OR "refundUntil" > "createdAt"),
  -- Prorrogação: aponta outra alteração e traz a nova data.
  ADD CONSTRAINT "EventChange_extension"
    CHECK ("extendsChangeId" IS NULL OR ("extendsChangeId" <> "id" AND "refundUntil" IS NOT NULL));

-- CancellationRequest (R5).
ALTER TABLE "CancellationRequest"
  ADD CONSTRAINT "CancellationRequest_protocol_format"
    CHECK ("protocol" ~ '^CAN-[0-9]{8}-[0-9A-HJKMNP-TV-Z]{6}$'),
  ADD CONSTRAINT "CancellationRequest_reason_present"
    CHECK (length(btrim("reason")) > 0),
  ADD CONSTRAINT "CancellationRequest_decision_state"
    CHECK (("status" = 'OPEN') = ("decidedAt" IS NULL)
       AND ("status" = 'OPEN' OR "decidedById" IS NOT NULL)),
  ADD CONSTRAINT "CancellationRequest_rejection_note"
    CHECK ("status" <> 'REJECTED' OR ("decisionNote" IS NOT NULL AND length(btrim("decisionNote")) > 0)),
  ADD CONSTRAINT "CancellationRequest_withdrawn_by_requester"
    CHECK ("status" <> 'WITHDRAWN' OR "decidedById" = "requestedById"),
  ADD CONSTRAINT "CancellationRequest_assignment"
    CHECK (("assignedToId" IS NULL) = ("assignedAt" IS NULL));

-- No máximo um pedido aberto por compra.
CREATE UNIQUE INDEX "CancellationRequest_one_open_per_order"
  ON "CancellationRequest" ("orderId") WHERE "status" = 'OPEN';

-- Sem DELETE; os dados do pedido não mudam; respondBy é definido uma vez; decidido = congelado.
CREATE OR REPLACE FUNCTION cancellation_request_guard() RETURNS trigger AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'CancellationRequest é histórico (DELETE bloqueado)';
  END IF;
  IF OLD."status" <> 'OPEN' THEN
    RAISE EXCEPTION 'CancellationRequest % já decidido (%): linha imutável', OLD."protocol", OLD."status";
  END IF;
  IF (NEW."id", NEW."protocol", NEW."orderId", NEW."eventId", NEW."organizationId",
      NEW."requestedById", NEW."reason", NEW."createdAt", NEW."autoEligibleAtRequest")
     IS DISTINCT FROM
     (OLD."id", OLD."protocol", OLD."orderId", OLD."eventId", OLD."organizationId",
      OLD."requestedById", OLD."reason", OLD."createdAt", OLD."autoEligibleAtRequest") THEN
    RAISE EXCEPTION 'CancellationRequest %: os dados do pedido não mudam', OLD."protocol";
  END IF;
  IF OLD."respondBy" IS NOT NULL AND NEW."respondBy" IS DISTINCT FROM OLD."respondBy" THEN
    RAISE EXCEPTION 'CancellationRequest %: prazo de resposta já definido', OLD."protocol";
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER "CancellationRequest_guard"
  BEFORE UPDATE OR DELETE ON "CancellationRequest"
  FOR EACH ROW EXECUTE FUNCTION cancellation_request_guard();

-- TermsVersion / TermsAcceptance (R10).
ALTER TABLE "TermsVersion"
  ADD CONSTRAINT "TermsVersion_text_hash_format" CHECK ("textHash" ~ '^[0-9a-f]{64}$'),
  ADD CONSTRAINT "TermsVersion_version_present" CHECK (length(btrim("version")) > 0);

ALTER TABLE "TermsAcceptance"
  ADD CONSTRAINT "TermsAcceptance_checkout_order"
    CHECK (("context" = 'CHECKOUT') = ("orderId" IS NOT NULL)),
  ADD CONSTRAINT "TermsAcceptance_organization"
    CHECK (("context" <> 'ORGANIZER_SIGNUP' OR "organizationId" IS NOT NULL)
       AND ("context" NOT IN ('SIGNUP', 'CHECKOUT') OR "organizationId" IS NULL));

-- Um aceite por versão por pedido e por organização. Cadastro/reaceite sem
-- organização ficam sem unicidade (um registro por evento de aceite).
CREATE UNIQUE INDEX "TermsAcceptance_order_once"
  ON "TermsAcceptance" ("userId", "termsVersionId", "orderId") WHERE "orderId" IS NOT NULL;
CREATE UNIQUE INDEX "TermsAcceptance_organization_once"
  ON "TermsAcceptance" ("userId", "termsVersionId", "organizationId") WHERE "organizationId" IS NOT NULL;

-- Somente inserção: EventChange, TermsVersion, TermsAcceptance (mesmo padrão de AuditLog).
CREATE OR REPLACE FUNCTION compliance_block_mutation() RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION '% é somente inserção (operação % bloqueada)', TG_TABLE_NAME, TG_OP;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER "EventChange_immutable"
  BEFORE UPDATE OR DELETE ON "EventChange"
  FOR EACH ROW EXECUTE FUNCTION compliance_block_mutation();

CREATE TRIGGER "TermsVersion_immutable"
  BEFORE UPDATE OR DELETE ON "TermsVersion"
  FOR EACH ROW EXECUTE FUNCTION compliance_block_mutation();

CREATE TRIGGER "TermsAcceptance_immutable"
  BEFORE UPDATE OR DELETE ON "TermsAcceptance"
  FOR EACH ROW EXECUTE FUNCTION compliance_block_mutation();
