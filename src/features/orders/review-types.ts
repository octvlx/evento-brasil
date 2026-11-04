import type { CreateOrderInput } from "@/features/schemas";
export interface CheckoutReviewData {
  draftId: string; selection: CreateOrderInput; reviewHash: string | null; confirmed: boolean;
  readiness: { email: boolean; profile: boolean; address: boolean };
  /** Motivo (servidor) pelo qual a regra da meia-entrada barra a seleção atual; null se pode. */
  halfPriceNotice: string | null;
  event: { title: string; slug: string; dateLabel: string; venueLabel: string; locationLabel: string };
  tickets: { id: string; name: string; kind: string; priceCents: number; available: number; unavailableReason: "SOLD_OUT" | "HALF_QUOTA_EXHAUSTED" | "RESERVED_FOR_HALF_PRICE" | null; minPerOrder: number; maxPerOrder: number; requiresAttendeeInfo: boolean }[];
  order: { id: string; publicCode: string; status: string; expiresAt: string; expiresLabel: string; grossSubtotalCents: number; items: { id: string; ticketTypeId: string; ticketTypeName: string; quantity: number; listUnitPriceCents: number; serviceFeePerUnitCents: number; lineSubtotalCents: number }[]; subtotalCents: number; serviceFeeCents: number; discountCents: number; totalCents: number; couponCode: string | null } | null;
}
