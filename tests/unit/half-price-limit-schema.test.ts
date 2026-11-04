// L7c: o campo "limite de meia-entrada" aceita vazio (sem limite além da cota) e >= 40%.
import { describe, expect, it } from "vitest";
import { eventInputSchema } from "@/features/schemas";

const shape = eventInputSchema.shape.halfPriceQuotaPercent;

describe("halfPriceQuotaPercent", () => {
  it("vazio, nulo ou ausente = sem limite", () => {
    expect(shape.parse("")).toBeUndefined();
    expect(shape.parse(null)).toBeUndefined();
    expect(shape.parse(undefined)).toBeUndefined();
  });

  it("aceita de 40 a 100", () => {
    expect(shape.parse(40)).toBe(40);
    expect(shape.parse("40")).toBe(40);
    expect(shape.parse("55.5")).toBe(55.5);
    expect(shape.parse(100)).toBe(100);
  });

  it("recusa abaixo do mínimo legal com mensagem clara", () => {
    for (const v of [0, "0", 39.9, "30", 1]) {
      const r = shape.safeParse(v);
      expect(r.success).toBe(false);
      expect(r.error?.issues[0].message).toMatch(/mínimo legal de 40%/);
    }
  });

  it("recusa acima de 100 e texto", () => {
    expect(shape.safeParse(101).success).toBe(false);
    expect(shape.safeParse("abc").success).toBe(false);
  });
});
