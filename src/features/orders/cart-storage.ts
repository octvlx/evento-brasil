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
