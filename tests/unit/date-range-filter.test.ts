import { describe, expect, it } from "vitest";
import { customDateRange, MAX_DATE_RANGE_DAYS } from "@/server/services/catalog";

// 21/11/2026 10:00 em Brasília (UTC-3, sem horário de verão).
const now = new Date("2026-11-21T13:00:00.000Z");

describe("customDateRange", () => {
  it("dias inteiros no fuso de Brasília, com o dia final incluído", () => {
    expect(customDateRange("2026-12-05", "2026-12-07", now)).toEqual({
      from: new Date("2026-12-05T03:00:00.000Z"),
      to: new Date("2026-12-08T03:00:00.000Z"),
    });
    // Um dia só.
    expect(customDateRange("2026-12-05", "2026-12-05", now)).toEqual({
      from: new Date("2026-12-05T03:00:00.000Z"),
      to: new Date("2026-12-06T03:00:00.000Z"),
    });
  });

  it("só 'ate': de hoje até o fim do dia; só 'de': até o limite do período", () => {
    expect(customDateRange(undefined, "2026-11-30", now)).toEqual({
      from: new Date("2026-11-21T03:00:00.000Z"),
      to: new Date("2026-12-01T03:00:00.000Z"),
    });
    const open = customDateRange("2026-12-01", "", now)!;
    expect(open.from).toEqual(new Date("2026-12-01T03:00:00.000Z"));
    expect(Math.round((open.to.getTime() - open.from.getTime()) / 86_400_000)).toBe(MAX_DATE_RANGE_DAYS);
  });

  it.each([
    ["sem datas", undefined, undefined],
    ["vazias", "", ""],
    ["fim antes do início", "2026-12-10", "2026-12-01"],
    ["data inexistente", "2026-02-30", "2026-03-02"],
    ["formato errado", "05/12/2026", undefined],
    ["um lado inválido anula o período", "2026-12-01", "amanhã"],
    ["'ate' no passado", undefined, "2026-11-01"],
    ["período longo demais", "2026-01-01", "2027-06-01"],
    ["valor não textual", ["2026-12-01"], undefined],
  ])("ignora o período: %s", (_name, de, ate) => {
    expect(customDateRange(de, ate, now)).toBeNull();
  });
});
