import "server-only";
import { createHash } from "node:crypto";
import { createOrderSchema, type CreateOrderInput } from "@/features/schemas";
import type { CheckoutDraft, Prisma } from "@/generated/prisma/client";
import type { Actor } from "../auth/permissions";
import { assertActive } from "../auth/permissions";
import { hashToken, safeEqual } from "../crypto";
import { TX_OPTIONS, type Db, type Tx } from "../db";
import { AppError, forbidden, invalidState, notFound } from "../errors";
import { getPaymentAdapter } from "../payments";
import { audit } from "../audit";
import { resolveCommissionRule } from "./commission";
import { createOrder, finalizePaidOrderTx, lockCoupons, lockEvent, lockOrder, releaseOrderTx } from "./orders";
import { postSale } from "./ledger";
import { notifyOrderPaid } from "./notifications";
import { checkoutTermsGate, recordAcceptanceTx } from "./terms";

const digest = (value: unknown) => createHash("sha256").update(JSON.stringify(value)).digest("hex");
const eventInclude = { venue: { include: { city: true } }, city: true, ticketTypes: { orderBy: { id: "asc" as const } } };
const orderInclude = { items: { orderBy: { id: "asc" as const } } };
const ownershipError = () => forbidden("Carrinho não encontrado para esta conta.");
function checkAccess(draft: CheckoutDraft | null, actor: Actor, token?: string) {
  assertActive(actor);
  if (!draft || (draft.userId && draft.userId !== actor.id) || (!draft.userId && (!token || !safeEqual(hashToken(token), draft.tokenHash)))) throw ownershipError();
  if (draft.expiresAt <= new Date()) throw new AppError("SALES_CLOSED", "Este carrinho expirou. Selecione os ingressos novamente.");
  return draft;
}
async function lockDraft(tx: Tx, id: string, actor: Actor, token?: string) {
  await tx.$queryRaw`SELECT id FROM "CheckoutDraft" WHERE id = ${id} FOR UPDATE`;
  return checkAccess(await tx.checkoutDraft.findUnique({ where: { id } }), actor, token);
}
export async function checkoutReadiness(client: Db | Tx, userId: string) {
  const buyer = await client.user.findUniqueOrThrow({ where: { id: userId }, include: { address: true } });
  return { buyer, readiness: { email: !!buyer.emailVerifiedAt, profile: !!(buyer.cpfEncrypted && buyer.cpfHash && buyer.cpfLast2 && buyer.birthDate), address: !!buyer.address } };
}
function requireReady(readiness: { email: boolean; profile: boolean; address: boolean }) {
  if (!readiness.email) throw new AppError("VALIDATION", "Confirme seu e-mail antes de continuar a compra.");
  if (!readiness.profile) throw new AppError("VALIDATION", "Complete CPF e data de nascimento antes de continuar.");
  if (!readiness.address) throw new AppError("VALIDATION", "Cadastre seu endereço antes da primeira compra.");
}

/** No inventory or order is created before authentication/profile completion. */
export async function createCheckoutDraft(db: Db, raw: CreateOrderInput, actor?: Actor | null) {
  if (actor) assertActive(actor);
  const input = createOrderSchema.parse(raw);
  const token = hashToken(`checkout-draft:${input.idempotencyKey}`);
  const existing = await db.checkoutDraft.findUnique({ where: { idempotencyKey: input.idempotencyKey } });
  if (existing) {
    if (!safeEqual(existing.tokenHash, hashToken(token)) || (existing.userId && existing.userId !== actor?.id)) throw ownershipError();
    if (existing.expiresAt <= new Date()) throw new AppError("SALES_CLOSED", "Este carrinho expirou. Inicie outra seleção de ingressos.");
    return { draftId: existing.id, token };
  }
  const event = await db.event.findFirst({ where: { id: input.eventId, status: "PUBLISHED", organization: { status: "APPROVED" } }, select: { id: true } });
  if (!event) throw notFound("Evento indisponível.");
  try {
    const draft = await db.checkoutDraft.create({ data: { idempotencyKey: input.idempotencyKey, tokenHash: hashToken(token), userId: actor?.id ?? null, eventId: input.eventId, selection: input as Prisma.InputJsonValue, expiresAt: new Date(Date.now() + 24 * 60 * 60_000) } });
    return { draftId: draft.id, token };
  } catch (error) {
    // A repeated browser request with the same unexposed random key recovers its cart.
    const again = await db.checkoutDraft.findUnique({ where: { idempotencyKey: input.idempotencyKey } });
    if (!again || !safeEqual(again.tokenHash, hashToken(token)) || (again.userId && again.userId !== actor?.id)) throw error;
    return { draftId: again.id, token };
  }
}

/** Read-only, safe for server rendering/prefetch. Preparing inventory is a separate POST action. */
export async function getCheckoutReview(db: Db, actor: Actor, draftId: string, token?: string) {
  const draft = checkAccess(await db.checkoutDraft.findUnique({ where: { id: draftId } }), actor, token);
  const [event, order, ready] = await Promise.all([
    db.event.findUniqueOrThrow({ where: { id: draft.eventId }, include: eventInclude }),
    draft.orderId ? db.order.findUnique({ where: { id: draft.orderId }, include: orderInclude }) : null,
    checkoutReadiness(db, actor.id),
  ]);
  return { draft: { id: draft.id, selection: draft.selection, expiresAt: draft.expiresAt, confirmedAt: draft.confirmedAt, revision: draft.revision, orderId: draft.orderId }, event, order, readiness: ready.readiness, reviewHash: draft.reviewHash };
}

function revisionKey(draft: CheckoutDraft) {
  const hex = digest(`${draft.id}:${draft.revision}`);
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-4${hex.slice(13, 16)}-a${hex.slice(17, 20)}-${hex.slice(20, 32)}`;
}
async function financialFingerprint(tx: Tx, draft: CheckoutDraft) {
  const input = createOrderSchema.parse(draft.selection);
  const event = await tx.event.findUniqueOrThrow({ where: { id: draft.eventId }, include: { ticketTypes: { orderBy: { id: "asc" } } } });
  const rule = await resolveCommissionRule(tx, event.organizationId, event.id);
  const coupon = input.couponCode ? await tx.coupon.findUnique({ where: { organizationId_code: { organizationId: event.organizationId, code: input.couponCode.trim().toUpperCase() } }, include: { ticketTypes: { orderBy: { ticketTypeId: "asc" } } } }) : null;
  return digest({ event: { status: event.status, salesStartAt: event.salesStartAt, salesEndAt: event.salesEndAt, startsAt: event.startsAt, endsAt: event.endsAt }, types: event.ticketTypes.map(t => ({ id: t.id, price: t.priceCents, hidden: t.isHidden, salesStart: t.salesStartAt, salesEnd: t.salesEndAt, requiresAttendeeInfo: t.requiresAttendeeInfo })), rule, coupon: coupon && { id: coupon.id, type: coupon.discountType, percent: coupon.percentBps, fixed: coupon.amountCents, validFrom: coupon.validFrom, validUntil: coupon.validUntil, disabledAt: coupon.disabledAt, ticketTypes: coupon.ticketTypes } });
}
async function reviewFingerprint(tx: Tx, draft: CheckoutDraft) {
  if (!draft.orderId) return null;
  const { buyer, readiness } = await checkoutReadiness(tx, draft.userId!);
  requireReady(readiness);
  const order = await tx.order.findUniqueOrThrow({ where: { id: draft.orderId }, include: orderInclude });
  const event = await tx.event.findUniqueOrThrow({ where: { id: draft.eventId }, select: { title: true, startsAt: true, timezone: true, venueId: true, locationType: true, onlineUrl: true } });
  return digest({ buyer: { name: buyer.name, email: buyer.email, cpfHash: buyer.cpfHash, birthDate: buyer.birthDate, emailVerifiedAt: buyer.emailVerifiedAt }, address: buyer.address, event, order: { id: order.id, expiresAt: order.expiresAt, items: order.items, subtotal: order.subtotalCents, serviceFee: order.serviceFeeCents, discount: order.discountCents, total: order.totalCents, coupon: order.couponCode } });
}
async function prepareTx(tx: Tx, actor: Actor, current: CheckoutDraft) {
  const ready = await checkoutReadiness(tx, actor.id); requireReady(ready.readiness);
  let draft = current.userId ? current : await tx.checkoutDraft.update({ where: { id: current.id }, data: { userId: actor.id } });
  await lockEvent(tx, draft.eventId);
  const fingerprint = await financialFingerprint(tx, draft);
  const previous = draft.orderId ? await tx.order.findUniqueOrThrow({ where: { id: draft.orderId }, include: { payments: true } }) : null;
  if (previous?.status === "PAID") return draft;
  const reusable = previous?.status === "PENDING_PAYMENT" && previous.expiresAt > new Date() && draft.pricingHash === fingerprint;
  if (previous?.payments.length && !reusable) throw invalidState("Já existe uma tentativa de pagamento. Acompanhe o pedido antes de alterar a compra.");
  if (!reusable) {
    // A new revision creates at most one replacement using the existing order/inventory service.
    if (previous) draft = await tx.checkoutDraft.update({ where: { id: draft.id }, data: { revision: { increment: 1 } } });
    const selection = createOrderSchema.parse(draft.selection);
    const adapter = getPaymentAdapter();
    const order = await createOrder(tx as unknown as Db, actor, { ...selection, buyerName: ready.buyer.name, buyerEmail: ready.buyer.email, buyerPhone: ready.buyer.phone ?? undefined, idempotencyKey: revisionKey(draft) }, { transaction: tx, checkoutReviewRequired: true, providerIsSimulated: adapter.isSimulated, paymentsAvailable: adapter.supportedMethods.length > 0 });
    draft = await tx.checkoutDraft.update({ where: { id: draft.id }, data: { orderId: order.id, pricingHash: fingerprint, confirmedAt: null, reviewHash: null } });
  }
  // Always snapshot currently saved personal/address data; no CPF plaintext is exposed here.
  const reviewHash = await reviewFingerprint(tx, draft);
  if (reviewHash !== draft.reviewHash) {
    if (draft.orderId) await tx.order.update({ where: { id: draft.orderId }, data: { buyerName: ready.buyer.name, buyerEmail: ready.buyer.email, buyerPhone: ready.buyer.phone, checkoutReviewedAt: null } });
    draft = await tx.checkoutDraft.update({ where: { id: draft.id }, data: { reviewHash, confirmedAt: null } });
  }
  return draft;
}
export async function prepareCheckoutReview(db: Db, actor: Actor, draftId: string, token?: string) {
  await db.$transaction(async tx => prepareTx(tx, actor, await lockDraft(tx, draftId, actor, token)), TX_OPTIONS);
  return getCheckoutReview(db, actor, draftId, token);
}

export async function updateCheckoutDraft(db: Db, actor: Actor, draftId: string, raw: CreateOrderInput, token?: string) {
  const selection = createOrderSchema.parse(raw);
  await db.$transaction(async tx => {
    const draft = await lockDraft(tx, draftId, actor, token);
    if (selection.eventId !== draft.eventId) throw new AppError("VALIDATION", "Não é possível trocar o evento deste carrinho.");
    if (draft.orderId) {
      await lockEvent(tx, draft.eventId); await lockOrder(tx, draft.orderId);
      const order = await tx.order.findUniqueOrThrow({ where: { id: draft.orderId }, include: { payments: true } });
      if (order.status !== "PENDING_PAYMENT" || order.payments.length) throw invalidState("Este pedido já iniciou o pagamento e não pode ser alterado.");
      await lockCoupons(tx, [order.couponId]);
      await releaseOrderTx(tx, order.id, "CANCELLED", "checkout_selection_edited");
    }
    await tx.checkoutDraft.update({ where: { id: draft.id }, data: { userId: actor.id, selection: selection as Prisma.InputJsonValue, orderId: null, revision: { increment: 1 }, reviewHash: null, pricingHash: null, confirmedAt: null } });
  }, TX_OPTIONS);
  return getCheckoutReview(db, actor, draftId, token);
}

export async function confirmCheckoutReview(db: Db, actor: Actor, draftId: string, expectedHash: string, token?: string, opts: { acceptTerms?: boolean; ip?: string; userAgent?: string } = {}) {
  const result = await db.$transaction(async tx => {
    let draft = await lockDraft(tx, draftId, actor, token);
    if (!draft.orderId || !draft.reviewHash) throw invalidState("Revise os valores e ingressos antes de confirmar.");
    const before = draft.reviewHash;
    draft = await prepareTx(tx, actor, draft);
    if (draft.reviewHash !== expectedHash || before !== expectedHash) return { orderId: draft.orderId!, changed: true, paid: false, notify: false };
    await lockEvent(tx, draft.eventId); await lockOrder(tx, draft.orderId!);
    const order = await tx.order.findUniqueOrThrow({ where: { id: draft.orderId! }, include: { items: true, event: { include: { organization: true } } } });
    if (order.status === "PAID" && draft.confirmedAt) return { orderId: order.id, changed: false, paid: true, notify: false };
    if (order.status !== "PENDING_PAYMENT" || order.expiresAt <= new Date()) throw new AppError("SALES_CLOSED", "A reserva expirou. Revise a compra novamente.");
    if (order.event.status !== "PUBLISHED" || order.event.organization.status !== "APPROVED") throw new AppError("SALES_CLOSED", "O evento não está mais disponível.");
    const reservations = await tx.ticketInventoryReservation.findMany({ where: { orderId: order.id, status: "ACTIVE", expiresAt: { gt: new Date() } } });
    if (reservations.reduce((sum, row) => sum + row.quantity, 0) !== order.items.reduce((sum, row) => sum + row.quantity, 0)) throw new AppError("SOLD_OUT", "A reserva não está mais disponível.");
    const pendingTerms = await checkoutTermsGate(tx, actor.id, opts.acceptTerms);
    await recordAcceptanceTx(tx, actor.id, pendingTerms, { context: "CHECKOUT", orderId: order.id, ip: opts.ip, userAgent: opts.userAgent });
    const now = new Date();
    await tx.order.update({ where: { id: order.id }, data: { checkoutReviewedAt: now } });
    await tx.checkoutDraft.update({ where: { id: draft.id }, data: { confirmedAt: now } });
    if (order.totalCents === 0) {
      await tx.payment.create({ data: { orderId: order.id, provider: "none", method: "FREE", status: "PAID", amountCents: 0, idempotencyKey: `free:${order.id}`, paidAt: now } });
      await finalizePaidOrderTx(tx, order, now); await postSale(tx, order, undefined);
    }
    await audit(tx, { actorUserId: actor.id, organizationId: order.organizationId, action: "checkout.review_confirmed", entityType: "Order", entityId: order.id, metadata: { totalCents: order.totalCents } });
    return { orderId: order.id, changed: false, paid: order.totalCents === 0, notify: order.totalCents === 0 };
  }, TX_OPTIONS);
  if (result.notify) notifyOrderPaid(db, result.orderId);
  const { notify: _notify, ...response } = result;
  void _notify;
  return response;
}

/** Must be checked inside the payment transaction after order ownership is known. */
export async function assertCheckoutReviewed(tx: Tx, order: { id: string; userId: string; checkoutReviewRequired: boolean; checkoutReviewedAt: Date | null }) {
  if (!order.checkoutReviewRequired) return; // Orders created before this feature keep their original lifecycle.
  const draft = await tx.checkoutDraft.findUnique({ where: { orderId: order.id } });
  if (!draft?.confirmedAt || !order.checkoutReviewedAt || !draft.reviewHash || draft.reviewHash !== await reviewFingerprint(tx, draft)) throw invalidState("Seus dados ou a compra mudaram. Revise a compra antes de iniciar o pagamento.");
}
