import type { CreateOrderInput } from "@/features/schemas";
import { z } from "zod";
const fields = {
  quantities: z.record(z.string().max(128), z.number().int().min(0).max(50)).refine((value) => Object.keys(value).length <= 10),
  attendees: z.record(z.string().max(128), z.array(z.string().max(120)).max(50)).refine((value) => Object.keys(value).length <= 10),
  halfPrice: z.boolean(), coupon: z.string().max(64), idempotencyKey: z.union([z.literal(""), z.string().uuid()]),
};
export function decodeCartField<T>(field: string, raw: string | null, initial: T): T {
  if (!raw || !(field in fields)) return initial;
  try { const parsed = fields[field as keyof typeof fields].safeParse(JSON.parse(raw)); return parsed.success ? parsed.data as T : initial; } catch { return initial; }
}
export function clearPurchasedSelection(storage: Pick<Storage, "getItem" | "removeItem">, eventId: string, purchasedKey: string) {
  const prefix = `eb-cart:${eventId}:`;
  if (decodeCartField("idempotencyKey", storage.getItem(prefix + "idempotencyKey"), "") !== purchasedKey) return false;
  for (const field of Object.keys(fields)) storage.removeItem(prefix + field);
  return true;
}

/** Extract only the server-accepted ticket selection, never buyer/profile/address data. */
export function acceptedCartEntries(selection: CreateOrderInput): [string, string][] | null {
  const snapshot = {
    quantities: Object.fromEntries(selection.items.map((item) => [item.ticketTypeId, item.quantity])),
    attendees: Object.fromEntries(selection.items.filter((item) => item.attendees).map((item) => [item.ticketTypeId, item.attendees!.map((person) => person.name)])),
    halfPrice: selection.halfPriceDeclaration ?? false, coupon: selection.couponCode ?? "", idempotencyKey: selection.idempotencyKey,
  };
  const entries: [string, string][] = [];
  for (const field of Object.keys(fields) as (keyof typeof fields)[]) {
    const parsed = fields[field].safeParse(snapshot[field]);
    if (!parsed.success) return null;
    entries.push([`eb-cart:${selection.eventId}:${field}`, JSON.stringify(parsed.data)]);
  }
  return entries;
}
export function persistAcceptedCartSelection(storage: Pick<Storage, "setItem">, entries: [string, string][]) {
  try { for (const [key, value] of entries) storage.setItem(key, value); return true; } catch { return false; }
}
