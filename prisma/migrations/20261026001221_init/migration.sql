-- CreateEnum
CREATE TYPE "PlatformRole" AS ENUM ('USER', 'ADMIN');

-- CreateEnum
CREATE TYPE "UserStatus" AS ENUM ('ACTIVE', 'SUSPENDED');

-- CreateEnum
CREATE TYPE "OrganizationStatus" AS ENUM ('DRAFT', 'PENDING_REVIEW', 'APPROVED', 'REJECTED', 'SUSPENDED');

-- CreateEnum
CREATE TYPE "OrganizerLegalType" AS ENUM ('INDIVIDUAL', 'COMPANY');

-- CreateEnum
CREATE TYPE "PaymentAccountStatus" AS ENUM ('NOT_CONNECTED', 'PENDING', 'CONNECTED', 'SIMULATED', 'DISABLED');

-- CreateEnum
CREATE TYPE "OrgRole" AS ENUM ('OWNER', 'ADMIN', 'EVENT_MANAGER', 'FINANCE', 'CHECKIN_STAFF');

-- CreateEnum
CREATE TYPE "VerificationStatus" AS ENUM ('SUBMITTED', 'APPROVED', 'REJECTED');

-- CreateEnum
CREATE TYPE "DocumentType" AS ENUM ('CPF', 'CNPJ');

-- CreateEnum
CREATE TYPE "EventStatus" AS ENUM ('DRAFT', 'PENDING_REVIEW', 'PUBLISHED', 'CANCELLED', 'COMPLETED', 'ARCHIVED');

-- CreateEnum
CREATE TYPE "LocationType" AS ENUM ('VENUE', 'ONLINE');

-- CreateEnum
CREATE TYPE "TicketKind" AS ENUM ('GENERAL', 'VIP', 'PROMOTIONAL', 'EARLY_BIRD', 'HALF_PRICE', 'FREE');

-- CreateEnum
CREATE TYPE "ReservationStatus" AS ENUM ('ACTIVE', 'CONVERTED', 'RELEASED');

-- CreateEnum
CREATE TYPE "OrderStatus" AS ENUM ('PENDING_PAYMENT', 'PAID', 'PAYMENT_FAILED', 'EXPIRED', 'CANCELLED', 'REFUND_PENDING', 'REFUNDED', 'DISPUTED');

-- CreateEnum
CREATE TYPE "PaymentMethod" AS ENUM ('PIX', 'CREDIT_CARD', 'FREE');

-- CreateEnum
CREATE TYPE "PaymentStatus" AS ENUM ('PENDING', 'PAID', 'FAILED', 'EXPIRED', 'CANCELLED', 'REFUNDED', 'DISPUTED', 'CHARGED_BACK');

-- CreateEnum
CREATE TYPE "SimulatedPaymentState" AS ENUM ('PENDING', 'APPROVED', 'REJECTED', 'EXPIRED', 'REFUNDED', 'CHARGED_BACK');

-- CreateEnum
CREATE TYPE "TicketStatus" AS ENUM ('VALID', 'CHECKED_IN', 'REVOKED');

-- CreateEnum
CREATE TYPE "TicketRevocationReason" AS ENUM ('REFUNDED', 'EVENT_CANCELLED', 'CHARGEBACK', 'ADMIN');

-- CreateEnum
CREATE TYPE "CheckinResult" AS ENUM ('ADMITTED', 'DUPLICATE', 'WRONG_EVENT', 'REVOKED', 'INVALID', 'EVENT_NOT_ACTIVE');

-- CreateEnum
CREATE TYPE "RefundStatus" AS ENUM ('REQUESTED', 'PROCESSING', 'SUCCEEDED', 'REJECTED', 'FAILED');

-- CreateEnum
CREATE TYPE "RefundReason" AS ENUM ('CUSTOMER_REQUEST', 'EVENT_CANCELLED', 'LATE_PAYMENT_NO_INVENTORY', 'ADMIN');

-- CreateEnum
CREATE TYPE "CommissionScope" AS ENUM ('PLATFORM', 'ORGANIZATION', 'EVENT');

-- CreateEnum
CREATE TYPE "FeeBearer" AS ENUM ('ORGANIZER', 'BUYER');

-- CreateEnum
CREATE TYPE "LedgerAccount" AS ENUM ('CUSTOMER_FUNDS', 'ORGANIZER_PAYABLE', 'PLATFORM_COMMISSION', 'PLATFORM_SERVICE_FEE', 'PROCESSING_FEES');

-- CreateEnum
CREATE TYPE "LedgerDirection" AS ENUM ('DEBIT', 'CREDIT');

-- CreateEnum
CREATE TYPE "LedgerEntryType" AS ENUM ('SALE', 'PROCESSING_FEE', 'REFUND', 'CHARGEBACK', 'SETTLEMENT', 'ADJUSTMENT');

-- CreateEnum
CREATE TYPE "SettlementStatus" AS ENUM ('NOT_CONFIGURED', 'PENDING', 'IN_TRANSIT', 'PAID', 'FAILED');

-- CreateTable
CREATE TABLE "User" (
    "id" TEXT NOT NULL,
    "email" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "phone" TEXT,
    "passwordHash" TEXT NOT NULL,
    "platformRole" "PlatformRole" NOT NULL DEFAULT 'USER',
    "status" "UserStatus" NOT NULL DEFAULT 'ACTIVE',
    "suspendedReason" TEXT,
    "isDemoAccount" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "User_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Session" (
    "id" TEXT NOT NULL,
    "tokenHash" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "expiresAt" TIMESTAMPTZ(3) NOT NULL,
    "lastSeenAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "userAgent" TEXT,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Session_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Organization" (
    "id" TEXT NOT NULL,
    "slug" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "description" TEXT,
    "legalType" "OrganizerLegalType" NOT NULL,
    "contactEmail" TEXT NOT NULL,
    "contactPhone" TEXT,
    "cityId" TEXT,
    "websiteUrl" TEXT,
    "instagramHandle" TEXT,
    "status" "OrganizationStatus" NOT NULL DEFAULT 'DRAFT',
    "autoPublishEvents" BOOLEAN NOT NULL DEFAULT false,
    "paymentProvider" TEXT,
    "paymentAccountStatus" "PaymentAccountStatus" NOT NULL DEFAULT 'NOT_CONNECTED',
    "paymentAccountExternalId" TEXT,
    "statusReason" TEXT,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "Organization_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "OrganizationMember" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "role" "OrgRole" NOT NULL,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "OrganizationMember_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "OrganizationInvitation" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "email" TEXT NOT NULL,
    "role" "OrgRole" NOT NULL,
    "eventId" TEXT,
    "tokenHash" TEXT NOT NULL,
    "invitedById" TEXT NOT NULL,
    "expiresAt" TIMESTAMPTZ(3) NOT NULL,
    "acceptedAt" TIMESTAMPTZ(3),
    "acceptedById" TEXT,
    "revokedAt" TIMESTAMPTZ(3),
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "OrganizationInvitation_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "OrganizerVerification" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "legalType" "OrganizerLegalType" NOT NULL,
    "legalName" TEXT NOT NULL,
    "documentType" "DocumentType" NOT NULL,
    "documentEncrypted" TEXT NOT NULL,
    "documentLast4" TEXT NOT NULL,
    "status" "VerificationStatus" NOT NULL DEFAULT 'SUBMITTED',
    "submittedById" TEXT NOT NULL,
    "reviewedById" TEXT,
    "reviewedAt" TIMESTAMPTZ(3),
    "decisionNote" TEXT,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "OrganizerVerification_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "City" (
    "id" TEXT NOT NULL,
    "slug" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "state" CHAR(2) NOT NULL,
    "ibgeCode" TEXT,
    "timezone" TEXT NOT NULL,
    "isFeatured" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "City_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Venue" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT,
    "cityId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "slug" TEXT NOT NULL,
    "addressLine" TEXT,
    "district" TEXT,
    "postalCode" TEXT,
    "capacity" INTEGER,
    "accessibilityInfo" TEXT,
    "isFictional" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "Venue_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "EventCategory" (
    "id" TEXT NOT NULL,
    "slug" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "sortOrder" INTEGER NOT NULL DEFAULT 0,

    CONSTRAINT "EventCategory_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Event" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "slug" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "summary" TEXT,
    "description" TEXT NOT NULL,
    "categoryId" TEXT NOT NULL,
    "coverImageUrl" TEXT,
    "locationType" "LocationType" NOT NULL DEFAULT 'VENUE',
    "venueId" TEXT,
    "onlineUrl" TEXT,
    "cityId" TEXT,
    "startsAt" TIMESTAMPTZ(3) NOT NULL,
    "endsAt" TIMESTAMPTZ(3) NOT NULL,
    "timezone" TEXT NOT NULL,
    "ageRestriction" INTEGER NOT NULL DEFAULT 0,
    "salesStartAt" TIMESTAMPTZ(3) NOT NULL,
    "salesEndAt" TIMESTAMPTZ(3) NOT NULL,
    "capacity" INTEGER NOT NULL,
    "halfPriceQuotaBps" INTEGER,
    "status" "EventStatus" NOT NULL DEFAULT 'DRAFT',
    "isFeatured" BOOLEAN NOT NULL DEFAULT false,
    "refundPolicy" TEXT NOT NULL,
    "accessibilityInfo" TEXT,
    "moderationNote" TEXT,
    "publishedAt" TIMESTAMPTZ(3),
    "cancelledAt" TIMESTAMPTZ(3),
    "cancellationReason" TEXT,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "Event_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "EventImage" (
    "id" TEXT NOT NULL,
    "eventId" TEXT NOT NULL,
    "url" TEXT NOT NULL,
    "storageKey" TEXT,
    "alt" TEXT NOT NULL,
    "sortOrder" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "EventImage_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "EventStaffAssignment" (
    "id" TEXT NOT NULL,
    "eventId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "assignedById" TEXT NOT NULL,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "EventStaffAssignment_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "TicketType" (
    "id" TEXT NOT NULL,
    "eventId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "description" TEXT,
    "kind" "TicketKind" NOT NULL DEFAULT 'GENERAL',
    "priceCents" INTEGER NOT NULL,
    "quantityTotal" INTEGER NOT NULL,
    "quantityReserved" INTEGER NOT NULL DEFAULT 0,
    "quantitySold" INTEGER NOT NULL DEFAULT 0,
    "quantityRefunded" INTEGER NOT NULL DEFAULT 0,
    "quantityCancelled" INTEGER NOT NULL DEFAULT 0,
    "minPerOrder" INTEGER NOT NULL DEFAULT 1,
    "maxPerOrder" INTEGER NOT NULL DEFAULT 10,
    "salesStartAt" TIMESTAMPTZ(3),
    "salesEndAt" TIMESTAMPTZ(3),
    "requiresAttendeeInfo" BOOLEAN NOT NULL DEFAULT false,
    "isHidden" BOOLEAN NOT NULL DEFAULT false,
    "sortOrder" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "TicketType_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "TicketInventoryReservation" (
    "id" TEXT NOT NULL,
    "orderId" TEXT NOT NULL,
    "ticketTypeId" TEXT NOT NULL,
    "quantity" INTEGER NOT NULL,
    "status" "ReservationStatus" NOT NULL DEFAULT 'ACTIVE',
    "expiresAt" TIMESTAMPTZ(3) NOT NULL,
    "releasedAt" TIMESTAMPTZ(3),
    "releaseReason" TEXT,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "TicketInventoryReservation_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Order" (
    "id" TEXT NOT NULL,
    "publicCode" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "eventId" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "status" "OrderStatus" NOT NULL DEFAULT 'PENDING_PAYMENT',
    "currency" TEXT NOT NULL DEFAULT 'BRL',
    "subtotalCents" INTEGER NOT NULL,
    "serviceFeeCents" INTEGER NOT NULL,
    "totalCents" INTEGER NOT NULL,
    "commissionCents" INTEGER NOT NULL,
    "feePolicyVersion" TEXT NOT NULL,
    "commissionRuleId" TEXT,
    "buyerName" TEXT NOT NULL,
    "buyerEmail" TEXT NOT NULL,
    "buyerPhone" TEXT,
    "idempotencyKey" TEXT NOT NULL,
    "isSimulated" BOOLEAN NOT NULL DEFAULT false,
    "expiresAt" TIMESTAMPTZ(3) NOT NULL,
    "paidAt" TIMESTAMPTZ(3),
    "cancelledAt" TIMESTAMPTZ(3),
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "Order_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "OrderItem" (
    "id" TEXT NOT NULL,
    "orderId" TEXT NOT NULL,
    "ticketTypeId" TEXT NOT NULL,
    "ticketTypeName" TEXT NOT NULL,
    "kind" "TicketKind" NOT NULL,
    "unitPriceCents" INTEGER NOT NULL,
    "commissionPerUnitCents" INTEGER NOT NULL,
    "serviceFeePerUnitCents" INTEGER NOT NULL,
    "quantity" INTEGER NOT NULL,
    "attendees" JSONB,

    CONSTRAINT "OrderItem_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Payment" (
    "id" TEXT NOT NULL,
    "orderId" TEXT NOT NULL,
    "provider" TEXT NOT NULL,
    "providerPaymentId" TEXT,
    "method" "PaymentMethod" NOT NULL,
    "status" "PaymentStatus" NOT NULL DEFAULT 'PENDING',
    "amountCents" INTEGER NOT NULL,
    "processingFeeCents" INTEGER,
    "pixCopyPaste" TEXT,
    "pixQrCodeBase64" TEXT,
    "checkoutUrl" TEXT,
    "providerExpiresAt" TIMESTAMPTZ(3),
    "providerRawStatus" TEXT,
    "failureReason" TEXT,
    "isSimulated" BOOLEAN NOT NULL DEFAULT false,
    "idempotencyKey" TEXT NOT NULL,
    "paidAt" TIMESTAMPTZ(3),
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "Payment_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "PaymentWebhookEvent" (
    "id" TEXT NOT NULL,
    "provider" TEXT NOT NULL,
    "externalEventId" TEXT NOT NULL,
    "eventType" TEXT NOT NULL,
    "providerPaymentId" TEXT,
    "payload" JSONB NOT NULL,
    "receivedAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "processedAt" TIMESTAMPTZ(3),
    "processingResult" TEXT,
    "error" TEXT,
    "attempts" INTEGER NOT NULL DEFAULT 1,

    CONSTRAINT "PaymentWebhookEvent_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "SimulatedProviderPayment" (
    "id" TEXT NOT NULL,
    "externalRef" TEXT NOT NULL,
    "method" "PaymentMethod" NOT NULL,
    "amountCents" INTEGER NOT NULL,
    "state" "SimulatedPaymentState" NOT NULL DEFAULT 'PENDING',
    "expiresAt" TIMESTAMPTZ(3) NOT NULL,
    "refundedAt" TIMESTAMPTZ(3),
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "SimulatedProviderPayment_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "IssuedTicket" (
    "id" TEXT NOT NULL,
    "code" TEXT NOT NULL,
    "orderId" TEXT NOT NULL,
    "orderItemId" TEXT NOT NULL,
    "eventId" TEXT NOT NULL,
    "ticketTypeId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "sequence" INTEGER NOT NULL,
    "holderName" TEXT,
    "holderEmail" TEXT,
    "validationToken" TEXT NOT NULL,
    "status" "TicketStatus" NOT NULL DEFAULT 'VALID',
    "revokedAt" TIMESTAMPTZ(3),
    "revocationReason" "TicketRevocationReason",
    "checkedInAt" TIMESTAMPTZ(3),
    "issuedAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "IssuedTicket_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "TicketCheckin" (
    "id" TEXT NOT NULL,
    "ticketId" TEXT,
    "eventId" TEXT NOT NULL,
    "scannedById" TEXT NOT NULL,
    "result" "CheckinResult" NOT NULL,
    "scannedAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "TicketCheckin_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Refund" (
    "id" TEXT NOT NULL,
    "orderId" TEXT NOT NULL,
    "paymentId" TEXT,
    "amountCents" INTEGER NOT NULL,
    "status" "RefundStatus" NOT NULL DEFAULT 'REQUESTED',
    "reason" "RefundReason" NOT NULL,
    "requestedById" TEXT,
    "providerRefundId" TEXT,
    "note" TEXT,
    "idempotencyKey" TEXT NOT NULL,
    "processedAt" TIMESTAMPTZ(3),
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "Refund_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "CommissionRule" (
    "id" TEXT NOT NULL,
    "scope" "CommissionScope" NOT NULL,
    "organizationId" TEXT,
    "eventId" TEXT,
    "percentBps" INTEGER NOT NULL,
    "fixedCentsPerTicket" INTEGER NOT NULL DEFAULT 0,
    "bearer" "FeeBearer" NOT NULL DEFAULT 'ORGANIZER',
    "processingFeeBearer" "FeeBearer" NOT NULL DEFAULT 'ORGANIZER',
    "refundCommissionOnRefund" BOOLEAN NOT NULL DEFAULT true,
    "policyVersion" TEXT NOT NULL,
    "activeFrom" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "activeTo" TIMESTAMPTZ(3),
    "createdById" TEXT,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "CommissionRule_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "FinancialLedgerEntry" (
    "id" TEXT NOT NULL,
    "idempotencyKey" TEXT NOT NULL,
    "type" "LedgerEntryType" NOT NULL,
    "account" "LedgerAccount" NOT NULL,
    "direction" "LedgerDirection" NOT NULL,
    "amountCents" INTEGER NOT NULL,
    "organizationId" TEXT NOT NULL,
    "orderId" TEXT,
    "paymentId" TEXT,
    "refundId" TEXT,
    "settlementId" TEXT,
    "feePolicyVersion" TEXT,
    "description" TEXT NOT NULL,
    "isSimulated" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "FinancialLedgerEntry_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "OrganizerSettlement" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "provider" TEXT NOT NULL,
    "periodStart" TIMESTAMPTZ(3) NOT NULL,
    "periodEnd" TIMESTAMPTZ(3) NOT NULL,
    "grossCents" INTEGER NOT NULL,
    "commissionCents" INTEGER NOT NULL,
    "processingFeeCents" INTEGER NOT NULL,
    "refundCents" INTEGER NOT NULL,
    "netCents" INTEGER NOT NULL,
    "status" "SettlementStatus" NOT NULL DEFAULT 'NOT_CONFIGURED',
    "providerReference" TEXT,
    "isSimulated" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "OrganizerSettlement_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "AuditLog" (
    "id" TEXT NOT NULL,
    "actorUserId" TEXT,
    "organizationId" TEXT,
    "action" TEXT NOT NULL,
    "entityType" TEXT NOT NULL,
    "entityId" TEXT NOT NULL,
    "metadata" JSONB,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "AuditLog_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "User_email_key" ON "User"("email");

-- CreateIndex
CREATE UNIQUE INDEX "Session_tokenHash_key" ON "Session"("tokenHash");

-- CreateIndex
CREATE INDEX "Session_userId_idx" ON "Session"("userId");

-- CreateIndex
CREATE INDEX "Session_expiresAt_idx" ON "Session"("expiresAt");

-- CreateIndex
CREATE UNIQUE INDEX "Organization_slug_key" ON "Organization"("slug");

-- CreateIndex
CREATE INDEX "Organization_status_idx" ON "Organization"("status");

-- CreateIndex
CREATE INDEX "OrganizationMember_userId_idx" ON "OrganizationMember"("userId");

-- CreateIndex
CREATE UNIQUE INDEX "OrganizationMember_organizationId_userId_key" ON "OrganizationMember"("organizationId", "userId");

-- CreateIndex
CREATE UNIQUE INDEX "OrganizationInvitation_tokenHash_key" ON "OrganizationInvitation"("tokenHash");

-- CreateIndex
CREATE INDEX "OrganizationInvitation_organizationId_email_idx" ON "OrganizationInvitation"("organizationId", "email");

-- CreateIndex
CREATE INDEX "OrganizerVerification_organizationId_createdAt_idx" ON "OrganizerVerification"("organizationId", "createdAt");

-- CreateIndex
CREATE INDEX "OrganizerVerification_status_idx" ON "OrganizerVerification"("status");

-- CreateIndex
CREATE UNIQUE INDEX "City_slug_key" ON "City"("slug");

-- CreateIndex
CREATE UNIQUE INDEX "City_ibgeCode_key" ON "City"("ibgeCode");

-- CreateIndex
CREATE INDEX "City_state_idx" ON "City"("state");

-- CreateIndex
CREATE UNIQUE INDEX "City_name_state_key" ON "City"("name", "state");

-- CreateIndex
CREATE INDEX "Venue_organizationId_idx" ON "Venue"("organizationId");

-- CreateIndex
CREATE UNIQUE INDEX "Venue_cityId_slug_key" ON "Venue"("cityId", "slug");

-- CreateIndex
CREATE UNIQUE INDEX "EventCategory_slug_key" ON "EventCategory"("slug");

-- CreateIndex
CREATE UNIQUE INDEX "Event_slug_key" ON "Event"("slug");

-- CreateIndex
CREATE INDEX "Event_status_startsAt_idx" ON "Event"("status", "startsAt");

-- CreateIndex
CREATE INDEX "Event_cityId_status_startsAt_idx" ON "Event"("cityId", "status", "startsAt");

-- CreateIndex
CREATE INDEX "Event_organizationId_status_idx" ON "Event"("organizationId", "status");

-- CreateIndex
CREATE INDEX "Event_categoryId_status_idx" ON "Event"("categoryId", "status");

-- CreateIndex
CREATE INDEX "EventImage_eventId_idx" ON "EventImage"("eventId");

-- CreateIndex
CREATE INDEX "EventStaffAssignment_userId_idx" ON "EventStaffAssignment"("userId");

-- CreateIndex
CREATE UNIQUE INDEX "EventStaffAssignment_eventId_userId_key" ON "EventStaffAssignment"("eventId", "userId");

-- CreateIndex
CREATE INDEX "TicketType_eventId_sortOrder_idx" ON "TicketType"("eventId", "sortOrder");

-- CreateIndex
CREATE INDEX "TicketInventoryReservation_status_expiresAt_idx" ON "TicketInventoryReservation"("status", "expiresAt");

-- CreateIndex
CREATE UNIQUE INDEX "TicketInventoryReservation_orderId_ticketTypeId_key" ON "TicketInventoryReservation"("orderId", "ticketTypeId");

-- CreateIndex
CREATE UNIQUE INDEX "Order_publicCode_key" ON "Order"("publicCode");

-- CreateIndex
CREATE INDEX "Order_eventId_status_idx" ON "Order"("eventId", "status");

-- CreateIndex
CREATE INDEX "Order_organizationId_status_createdAt_idx" ON "Order"("organizationId", "status", "createdAt");

-- CreateIndex
CREATE INDEX "Order_status_expiresAt_idx" ON "Order"("status", "expiresAt");

-- CreateIndex
CREATE INDEX "Order_userId_createdAt_idx" ON "Order"("userId", "createdAt");

-- CreateIndex
CREATE UNIQUE INDEX "Order_userId_idempotencyKey_key" ON "Order"("userId", "idempotencyKey");

-- CreateIndex
CREATE UNIQUE INDEX "OrderItem_orderId_ticketTypeId_key" ON "OrderItem"("orderId", "ticketTypeId");

-- CreateIndex
CREATE UNIQUE INDEX "Payment_idempotencyKey_key" ON "Payment"("idempotencyKey");

-- CreateIndex
CREATE INDEX "Payment_orderId_idx" ON "Payment"("orderId");

-- CreateIndex
CREATE INDEX "Payment_status_createdAt_idx" ON "Payment"("status", "createdAt");

-- CreateIndex
CREATE UNIQUE INDEX "Payment_provider_providerPaymentId_key" ON "Payment"("provider", "providerPaymentId");

-- CreateIndex
CREATE INDEX "PaymentWebhookEvent_providerPaymentId_idx" ON "PaymentWebhookEvent"("providerPaymentId");

-- CreateIndex
CREATE UNIQUE INDEX "PaymentWebhookEvent_provider_externalEventId_key" ON "PaymentWebhookEvent"("provider", "externalEventId");

-- CreateIndex
CREATE UNIQUE INDEX "IssuedTicket_code_key" ON "IssuedTicket"("code");

-- CreateIndex
CREATE UNIQUE INDEX "IssuedTicket_validationToken_key" ON "IssuedTicket"("validationToken");

-- CreateIndex
CREATE INDEX "IssuedTicket_eventId_status_idx" ON "IssuedTicket"("eventId", "status");

-- CreateIndex
CREATE INDEX "IssuedTicket_userId_issuedAt_idx" ON "IssuedTicket"("userId", "issuedAt");

-- CreateIndex
CREATE INDEX "IssuedTicket_orderId_idx" ON "IssuedTicket"("orderId");

-- CreateIndex
CREATE UNIQUE INDEX "IssuedTicket_orderItemId_sequence_key" ON "IssuedTicket"("orderItemId", "sequence");

-- CreateIndex
CREATE INDEX "TicketCheckin_eventId_scannedAt_idx" ON "TicketCheckin"("eventId", "scannedAt");

-- CreateIndex
CREATE INDEX "TicketCheckin_ticketId_idx" ON "TicketCheckin"("ticketId");

-- CreateIndex
CREATE UNIQUE INDEX "Refund_idempotencyKey_key" ON "Refund"("idempotencyKey");

-- CreateIndex
CREATE INDEX "Refund_status_createdAt_idx" ON "Refund"("status", "createdAt");

-- CreateIndex
CREATE INDEX "Refund_orderId_idx" ON "Refund"("orderId");

-- CreateIndex
CREATE UNIQUE INDEX "CommissionRule_policyVersion_key" ON "CommissionRule"("policyVersion");

-- CreateIndex
CREATE INDEX "CommissionRule_scope_organizationId_eventId_activeFrom_idx" ON "CommissionRule"("scope", "organizationId", "eventId", "activeFrom");

-- CreateIndex
CREATE INDEX "FinancialLedgerEntry_organizationId_createdAt_idx" ON "FinancialLedgerEntry"("organizationId", "createdAt");

-- CreateIndex
CREATE INDEX "FinancialLedgerEntry_orderId_idx" ON "FinancialLedgerEntry"("orderId");

-- CreateIndex
CREATE UNIQUE INDEX "FinancialLedgerEntry_idempotencyKey_account_direction_key" ON "FinancialLedgerEntry"("idempotencyKey", "account", "direction");

-- CreateIndex
CREATE INDEX "OrganizerSettlement_organizationId_periodStart_idx" ON "OrganizerSettlement"("organizationId", "periodStart");

-- CreateIndex
CREATE INDEX "AuditLog_entityType_entityId_idx" ON "AuditLog"("entityType", "entityId");

-- CreateIndex
CREATE INDEX "AuditLog_organizationId_createdAt_idx" ON "AuditLog"("organizationId", "createdAt");

-- CreateIndex
CREATE INDEX "AuditLog_actorUserId_createdAt_idx" ON "AuditLog"("actorUserId", "createdAt");

-- CreateIndex
CREATE INDEX "AuditLog_createdAt_idx" ON "AuditLog"("createdAt");

-- AddForeignKey
ALTER TABLE "Session" ADD CONSTRAINT "Session_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Organization" ADD CONSTRAINT "Organization_cityId_fkey" FOREIGN KEY ("cityId") REFERENCES "City"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "OrganizationMember" ADD CONSTRAINT "OrganizationMember_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "Organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "OrganizationMember" ADD CONSTRAINT "OrganizationMember_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "OrganizationInvitation" ADD CONSTRAINT "OrganizationInvitation_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "Organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "OrganizerVerification" ADD CONSTRAINT "OrganizerVerification_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "Organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Venue" ADD CONSTRAINT "Venue_cityId_fkey" FOREIGN KEY ("cityId") REFERENCES "City"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Venue" ADD CONSTRAINT "Venue_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "Organization"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Event" ADD CONSTRAINT "Event_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "Organization"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Event" ADD CONSTRAINT "Event_categoryId_fkey" FOREIGN KEY ("categoryId") REFERENCES "EventCategory"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Event" ADD CONSTRAINT "Event_venueId_fkey" FOREIGN KEY ("venueId") REFERENCES "Venue"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Event" ADD CONSTRAINT "Event_cityId_fkey" FOREIGN KEY ("cityId") REFERENCES "City"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "EventImage" ADD CONSTRAINT "EventImage_eventId_fkey" FOREIGN KEY ("eventId") REFERENCES "Event"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "EventStaffAssignment" ADD CONSTRAINT "EventStaffAssignment_eventId_fkey" FOREIGN KEY ("eventId") REFERENCES "Event"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "EventStaffAssignment" ADD CONSTRAINT "EventStaffAssignment_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "TicketType" ADD CONSTRAINT "TicketType_eventId_fkey" FOREIGN KEY ("eventId") REFERENCES "Event"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "TicketInventoryReservation" ADD CONSTRAINT "TicketInventoryReservation_orderId_fkey" FOREIGN KEY ("orderId") REFERENCES "Order"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "TicketInventoryReservation" ADD CONSTRAINT "TicketInventoryReservation_ticketTypeId_fkey" FOREIGN KEY ("ticketTypeId") REFERENCES "TicketType"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Order" ADD CONSTRAINT "Order_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Order" ADD CONSTRAINT "Order_eventId_fkey" FOREIGN KEY ("eventId") REFERENCES "Event"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Order" ADD CONSTRAINT "Order_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "Organization"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Order" ADD CONSTRAINT "Order_commissionRuleId_fkey" FOREIGN KEY ("commissionRuleId") REFERENCES "CommissionRule"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "OrderItem" ADD CONSTRAINT "OrderItem_orderId_fkey" FOREIGN KEY ("orderId") REFERENCES "Order"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "OrderItem" ADD CONSTRAINT "OrderItem_ticketTypeId_fkey" FOREIGN KEY ("ticketTypeId") REFERENCES "TicketType"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Payment" ADD CONSTRAINT "Payment_orderId_fkey" FOREIGN KEY ("orderId") REFERENCES "Order"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "IssuedTicket" ADD CONSTRAINT "IssuedTicket_orderId_fkey" FOREIGN KEY ("orderId") REFERENCES "Order"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "IssuedTicket" ADD CONSTRAINT "IssuedTicket_orderItemId_fkey" FOREIGN KEY ("orderItemId") REFERENCES "OrderItem"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "IssuedTicket" ADD CONSTRAINT "IssuedTicket_eventId_fkey" FOREIGN KEY ("eventId") REFERENCES "Event"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "IssuedTicket" ADD CONSTRAINT "IssuedTicket_ticketTypeId_fkey" FOREIGN KEY ("ticketTypeId") REFERENCES "TicketType"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "IssuedTicket" ADD CONSTRAINT "IssuedTicket_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "TicketCheckin" ADD CONSTRAINT "TicketCheckin_ticketId_fkey" FOREIGN KEY ("ticketId") REFERENCES "IssuedTicket"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "TicketCheckin" ADD CONSTRAINT "TicketCheckin_eventId_fkey" FOREIGN KEY ("eventId") REFERENCES "Event"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "TicketCheckin" ADD CONSTRAINT "TicketCheckin_scannedById_fkey" FOREIGN KEY ("scannedById") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Refund" ADD CONSTRAINT "Refund_orderId_fkey" FOREIGN KEY ("orderId") REFERENCES "Order"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Refund" ADD CONSTRAINT "Refund_paymentId_fkey" FOREIGN KEY ("paymentId") REFERENCES "Payment"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CommissionRule" ADD CONSTRAINT "CommissionRule_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "Organization"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CommissionRule" ADD CONSTRAINT "CommissionRule_eventId_fkey" FOREIGN KEY ("eventId") REFERENCES "Event"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "FinancialLedgerEntry" ADD CONSTRAINT "FinancialLedgerEntry_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "Organization"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "FinancialLedgerEntry" ADD CONSTRAINT "FinancialLedgerEntry_orderId_fkey" FOREIGN KEY ("orderId") REFERENCES "Order"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "FinancialLedgerEntry" ADD CONSTRAINT "FinancialLedgerEntry_paymentId_fkey" FOREIGN KEY ("paymentId") REFERENCES "Payment"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "FinancialLedgerEntry" ADD CONSTRAINT "FinancialLedgerEntry_refundId_fkey" FOREIGN KEY ("refundId") REFERENCES "Refund"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "FinancialLedgerEntry" ADD CONSTRAINT "FinancialLedgerEntry_settlementId_fkey" FOREIGN KEY ("settlementId") REFERENCES "OrganizerSettlement"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "OrganizerSettlement" ADD CONSTRAINT "OrganizerSettlement_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "Organization"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AuditLog" ADD CONSTRAINT "AuditLog_actorUserId_fkey" FOREIGN KEY ("actorUserId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AuditLog" ADD CONSTRAINT "AuditLog_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "Organization"("id") ON DELETE SET NULL ON UPDATE CASCADE;
