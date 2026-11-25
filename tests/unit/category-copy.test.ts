import { describe, expect, it } from "vitest";
import { categoryLead, categorySummary } from "@/lib/category-copy";

const base = { categoryName: "Shows e música", cityName: "Franca", timezone: "America/Sao_Paulo" };
const stats = { firstStartsAt: null, lastStartsAt: null, minPriceCents: null, hasFree: false, venues: [] as string[] };

describe("texto das páginas categoria × cidade", () => {
  it("frase por categoria conhecida e genérica para categoria nova", () => {
    expect(categoryLead("stand-up", "Stand-up", "Franca")).toBe("Stand-up em Franca: noites de humor com comediantes da cena local e nacional.");
    expect(categoryLead("nova", "Feiras", "Franca")).toBe("Feiras em Franca: veja a programação e compre ingressos.");
  });

  it("resumo com quantidade, período, locais e preço", () => {
    const text = categorySummary({
      ...base,
      total: 3,
      stats: { firstStartsAt: new Date("2026-12-05T23:00:00Z"), lastStartsAt: new Date("2027-02-10T23:00:00Z"), minPriceCents: 4500, hasFree: false, venues: ["Arena", "Teatro Municipal", "Praça"] },
    });
    // formatBRL usa espaço não separável depois de "R$".
    expect(text.replace(/ /g, " ")).toBe("Há 3 eventos à venda, de dezembro de 2026 a fevereiro de 2027. Locais: Arena, Teatro Municipal e Praça. Ingressos a partir de R$ 45,00.");
  });

  it("um evento, mesmo mês, um local, gratuito", () => {
    const d = new Date("2026-12-05T23:00:00Z");
    expect(categorySummary({ ...base, total: 1, stats: { firstStartsAt: d, lastStartsAt: d, minPriceCents: 0, hasFree: true, venues: ["Arena"] } })).toBe(
      "Há 1 evento à venda, em dezembro de 2026. Local: Arena. Tem evento gratuito.",
    );
  });

  it("sem eventos: texto que aponta para outras categorias e cidades", () => {
    expect(categorySummary({ ...base, total: 0, stats })).toMatch(/^No momento não há eventos de shows e música à venda em Franca\./);
  });
});
