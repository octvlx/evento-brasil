import type { CreateOrderInput } from "@/features/schemas";
export interface CheckoutReviewData {
  draftId: string; selection: CreateOrderInput; reviewHash: string | null; confirmed: boolean;
  readiness: { email: boolean; profile: boolean; address: boolean };
  event: { title: string; slug: string; dateLabel: string; venueLabel: string; locationLabel: string };
  tickets: { id: string; name: string; kind: string; priceCents: number; available: number; minPerOrder: number; maxPerOrder: number; requiresAttendeeInfo: boolean }[];
  order: { id: string; publicCode: string; status: string; expiresAt: string; expiresLabel: string; grossSubtotalCents: number; items: { id: string; ticketTypeId: string; ticketTypeName: string; quantity: number; listUnitPriceCents: number; serviceFeePerUnitCents: number; lineSubtotalCents: number }[]; subtotalCents: number; serviceFeeCents: number; discountCents: number; totalCents: number; couponCode: string | null } | null;
}
