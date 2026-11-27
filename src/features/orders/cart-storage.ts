import type { CreateOrderInput } from "@/features/schemas";

// Validação do que fica no localStorage (entrada não confiável; o servidor confere tudo
// de novo ao reservar). Sem zod de propósito: este arquivo vai para a página do evento,
// e o zod pesava ~34 KB comprimidos no navegador. Mesmas regras do esquema antigo
// (tests/unit/cart-storage-validators.test.ts compara os dois).
type Check = { safeParse(v: unknown): { success: true; data: unknown } | { success: false } };
const ok = (data: unknown) => ({ success: true as const, data });
const no = { success: false as const };
const check = (test: (v: unknown) => unknown): Check => ({
  safeParse(v) {
    const data = test(v);
    return data === undefined ? no : ok(data);
  },
});
const isStr = (v: unknown, max: number): v is string => typeof v === "string" && v.length <= max;
const isPlainObject = (v: unknown): v is Record<string, unknown> => {
  if (typeof v !== "object" || v === null || Array.isArray(v)) return false;
  const proto = Object.getPrototypeOf(v);
  return proto === Object.prototype || proto === null;
};
/** Objeto simples, até 10 chaves de até 128 caracteres; cada valor passa por `value` (undefined = inválido). */
const record = (value: (v: unknown) => unknown) =>
  check((v) => {
    if (!isPlainObject(v)) return undefined;
    const keys = Object.keys(v);
    if (keys.length > 10) return undefined;
    const out: Record<string, unknown> = {};
    for (const k of keys) {
      // Como o zod: "__proto__" é ignorada (nem validada nem copiada; sem prototype pollution).
      if (k === "__proto__") continue;
      if (k.length > 128) return undefined;
      const parsed = value(v[k]);
      if (parsed === undefined) return undefined;
      out[k] = parsed;
    }
    return out;
  });
const list = (max: number, item: (v: unknown) => unknown) => (v: unknown) => {
  if (!Array.isArray(v) || v.length > max) return undefined;
  const out: unknown[] = [];
  for (const x of v) {
    const parsed = item(x);
    if (parsed === undefined) return undefined;
    out.push(parsed);
  }
  return out;
};
// Versões 1 a 8, nil e max: o mesmo formato que o z.string().uuid() aceitava.
const UUID = /^([0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[1-8][0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12}|00000000-0000-0000-0000-000000000000|ffffffff-ffff-ffff-ffff-ffffffffffff)$/;
const fields = {
  quantities: record((n) => (typeof n === "number" && Number.isSafeInteger(n) && n >= 0 && n <= 50 ? n : undefined)),
  attendees: record(list(50, (s) => (isStr(s, 120) ? s : undefined))),
  // Lugar marcado: assentos escolhidos por tipo (o servidor confere de novo ao reservar).
  // Só id e rótulo voltam (outras chaves do objeto são descartadas, como no z.object).
  seats: record(list(50, (s) => (isPlainObject(s) && isStr(s.id, 64) && isStr(s.label, 8) ? { id: s.id, label: s.label } : undefined))),
  halfPrice: check((v) => (typeof v === "boolean" ? v : undefined)),
  coupon: check((v) => (isStr(v, 64) ? v : undefined)),
  idempotencyKey: check((v) => (v === "" || (typeof v === "string" && UUID.test(v)) ? v : undefined)),
} satisfies Record<string, Check>;
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
    // O rascunho guarda só os ids; o rótulo volta quando o mapa é aberto.
    seats: Object.fromEntries(selection.items.filter((item) => item.seatIds?.length).map((item) => [item.ticketTypeId, item.seatIds!.map((id) => ({ id, label: "" }))])),
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
