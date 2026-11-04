import type { Metadata } from "next";
import Link from "next/link";
import { Suspense } from "react";
import { cookies } from "next/headers";
import { Alert, Skeleton } from "@/components/ui/primitives";
import { requireUser } from "@/server/auth/current";
import { db } from "@/server/db";
import { AppError } from "@/server/errors";
import { getCheckoutReview } from "@/server/services/checkout-review";
import { getBuyerCheckoutProfile } from "@/server/services/buyer-profile";
import { createOrderSchema } from "@/features/schemas";
import { CheckoutReview } from "@/features/orders/checkout-review";
import { formatDateLong, formatTime } from "@/lib/datetime";

export const metadata: Metadata = { title: "Revise sua compra", robots: { index: false } };
export default function ReviewPage({ params }: PageProps<"/checkout/revisao/[draftId]">) {
  return <div className="mx-auto max-w-5xl px-4 py-8 sm:px-6"><h1 className="font-display text-3xl font-extrabold tracking-tight">Revise sua compra</h1><p className="mt-2 text-muted-foreground">Confira seus dados, endereço, ingressos e valores antes de pagar.</p><Suspense fallback={<Skeleton className="mt-6 h-96" />}><Review params={params} /></Suspense></div>;
}
async function Review({ params }: { params: Promise<{ draftId: string }> }) {
  const { draftId } = await params; const user = await requireUser(`/checkout/revisao/${draftId}`);
  const result = await Promise.all([getCheckoutReview(db, user, draftId, (await cookies()).get(`eb_checkout_${draftId}`)?.value), getBuyerCheckoutProfile(db, user)]).then(([review, profile]) => ({ review, profile, error: null })).catch((error: unknown) => {
    if (!(error instanceof AppError)) throw error;
    return { review: null, profile: null, error: error.message };
  });
  if (!result.review) return <div className="mt-6 space-y-4"><Alert variant="danger">{result.error}</Alert><Link href="/eventos" className="font-semibold text-secondary underline">Voltar aos eventos</Link></div>;
  const { review, profile } = result;
    const { event, order, draft } = review;
    const selection = createOrderSchema.parse(draft.selection);
    return <CheckoutReview profile={profile} data={{
      draftId: draft.id, halfPriceNotice: review.halfPrice?.message ?? null, selection, reviewHash: review.reviewHash, confirmed: !!draft.confirmedAt, readiness: review.readiness,
      event: { title: event.title, slug: event.slug, dateLabel: `${formatDateLong(event.startsAt, event.timezone)} às ${formatTime(event.startsAt, event.timezone)}`, venueLabel: event.venue?.name ?? (event.locationType === "ONLINE" ? "Evento online" : "Local a confirmar"), locationLabel: [event.venue?.addressLine, event.venue?.city?.name ?? event.city?.name, event.venue?.city?.state ?? event.city?.state].filter(Boolean).join(" · ") },
      tickets: event.ticketTypes.filter((ticket) => !ticket.isHidden || selection.items.some((item) => item.ticketTypeId === ticket.id)).map((ticket) => ({ id: ticket.id, name: ticket.name, kind: ticket.kind, priceCents: ticket.priceCents, available: review.halfPrice?.availability[ticket.id]?.available ?? Math.max(0, ticket.quantityTotal - ticket.quantityReserved - ticket.quantitySold + (order?.items.find((item) => item.ticketTypeId === ticket.id)?.quantity ?? 0)), unavailableReason: review.halfPrice?.availability[ticket.id]?.reason ?? null, minPerOrder: ticket.minPerOrder, maxPerOrder: ticket.maxPerOrder, requiresAttendeeInfo: ticket.requiresAttendeeInfo })),
      order: order ? { id: order.id, publicCode: order.publicCode, status: order.status, expiresAt: order.expiresAt.toISOString(), expiresLabel: formatTime(order.expiresAt, event.timezone), grossSubtotalCents: order.subtotalCents + order.discountCents, items: order.items.map((item) => ({ id: item.id, ticketTypeId: item.ticketTypeId, ticketTypeName: item.ticketTypeName, quantity: item.quantity, listUnitPriceCents: item.listUnitPriceCents, serviceFeePerUnitCents: item.serviceFeePerUnitCents, lineSubtotalCents: item.listUnitPriceCents * item.quantity })), subtotalCents: order.subtotalCents, serviceFeeCents: order.serviceFeeCents, discountCents: order.discountCents, totalCents: order.totalCents, couponCode: order.couponCode } : null,
    }} />;
}
