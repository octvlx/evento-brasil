// A busca pública do header fica fora das áreas com layout próprio.
import { describe, expect, it } from "vitest";
import { headerSearchHidden } from "@/components/site/header-search";

describe("headerSearchHidden", () => {
  it.each(["/admin", "/admin/eventos", "/organizador", "/organizador/eventos/novo", "/checkout/abc", "/check-in", "/check-in/evt", "/pedido/123"])("oculta em %s", (p) => {
    expect(headerSearchHidden(p)).toBe(true);
  });
  it.each(["/", "/eventos", "/eventos/show-x", "/cidades/sao-paulo-sp", "/organizadores/sonora", "/entrar", "/checkout-info"])("mostra em %s", (p) => {
    expect(headerSearchHidden(p)).toBe(false);
  });
});
