// As validações do carrinho no localStorage deixaram de usar zod (peso no navegador).
// Aqui o esquema antigo, com zod, serve de referência: as duas versões precisam aceitar,
// recusar e devolver exatamente o mesmo para entradas boas e malformadas.
import { describe, expect, it } from "vitest";
import { z } from "zod";
import { decodeCartField } from "@/features/orders/cart-storage";

const legacy = {
  quantities: z.record(z.string().max(128), z.number().int().min(0).max(50)).refine((value) => Object.keys(value).length <= 10),
  attendees: z.record(z.string().max(128), z.array(z.string().max(120)).max(50)).refine((value) => Object.keys(value).length <= 10),
  seats: z.record(z.string().max(128), z.array(z.object({ id: z.string().max(64), label: z.string().max(8) })).max(50)).refine((value) => Object.keys(value).length <= 10),
  halfPrice: z.boolean(),
  coupon: z.string().max(64),
  idempotencyKey: z.union([z.literal(""), z.string().uuid()]),
};
type Field = keyof typeof legacy;
const INITIAL = Symbol("initial");
const legacyDecode = (field: Field, raw: string) => {
  try {
    const parsed = legacy[field].safeParse(JSON.parse(raw));
    return parsed.success ? parsed.data : INITIAL;
  } catch {
    return INITIAL;
  }
};

const long = (n: number) => "a".repeat(n);
const many = (n: number, v: unknown) => Object.fromEntries(Array.from({ length: n }, (_, i) => [`t${i}`, v]));
const values: unknown[] = [
  null, true, false, 0, 1, -1, 2.5, 50, 51, 1e21, "", "x", long(64), long(65), [], [1], {}, { a: 1 },
  { t: 0 }, { t: 50 }, { t: 51 }, { t: -1 }, { t: 1.5 }, { t: "2" }, { t: null }, { [long(128)]: 1 }, { [long(129)]: 1 },
  many(10, 1), many(11, 1), { t: [] }, { t: ["Ana", "Bia"] }, { t: [long(120)] }, { t: [long(121)] }, { t: [1] },
  { t: Array(50).fill("x") }, { t: Array(51).fill("x") }, many(10, ["x"]), many(11, ["x"]),
  { t: [{ id: "s1", label: "A1" }] }, { t: [{ id: "s1", label: "A1", extra: "drop" }] }, { t: [{ id: long(65), label: "A1" }] },
  { t: [{ id: "s1", label: long(9) }] }, { t: [{ id: "s1" }] }, { t: [null] }, { t: [["s1", "A1"]] }, { t: Array(51).fill({ id: "s", label: "" }) },
  crypto.randomUUID(), crypto.randomUUID().toUpperCase(), "00000000-0000-0000-0000-000000000000", "ffffffff-ffff-ffff-ffff-ffffffffffff",
  "123e4567-e89b-12d3-a456-426614174000", "123e4567-e89b-92d3-a456-426614174000", "123e4567-e89b-12d3-c456-426614174000", "123e4567e89b12d3a456426614174000",
  ` ${crypto.randomUUID()}`,
];
const raws = [...values.map((v) => JSON.stringify(v)), "broken", "{", '{"__proto__":{"x":1}}', '{"__proto__":1,"t":2}', '{"t":[{"id":"s","label":"A","__proto__":{"x":1}}]}', '{"t":1,"t":2}', '"\\u0000"'];

describe("validação do carrinho sem zod", () => {
  it("aceita, recusa e devolve o mesmo que o esquema antigo em todos os campos", () => {
    for (const field of Object.keys(legacy) as Field[]) {
      for (const raw of raws) {
        const expected = legacyDecode(field, raw);
        const got = decodeCartField(field, raw, INITIAL);
        expect({ field, raw, got }).toEqual({ field, raw, got: expected });
      }
    }
  });

  it("chave __proto__ não contamina o protótipo", () => {
    const got = decodeCartField<Record<string, unknown>>("quantities", '{"__proto__":{"polluted":1},"t":2}', {});
    expect(got).toEqual({ t: 2 });
    expect(Object.getPrototypeOf(got)).toBe(Object.prototype);
    expect(({} as Record<string, unknown>).polluted).toBeUndefined();
  });

  it("campo desconhecido ou vazio devolve o valor inicial", () => {
    expect(decodeCartField("outro", '{"t":1}', "inicial")).toBe("inicial");
    expect(decodeCartField("quantities", null, "inicial")).toBe("inicial");
  });
});
