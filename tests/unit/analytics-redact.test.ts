import { describe, expect, it } from "vitest";
import { redactAnalyticsEvent, redactAnalyticsUrl } from "@/lib/analytics-redact";

const site = "https://ticket24.com.br";

describe("redactAnalyticsUrl", () => {
  it("tira os tokens dos links que dão acesso", () => {
    expect(redactAnalyticsUrl(`${site}/convite/abc123segredo`)).toBe(`${site}/convite/[token]`);
    expect(redactAnalyticsUrl(`${site}/transferencia/tok_XYZ`)).toBe(`${site}/transferencia/[token]`);
    expect(redactAnalyticsUrl(`${site}/organizador/propriedade/tok_XYZ`)).toBe(`${site}/organizador/propriedade/[token]`);
  });

  it("tira códigos de ingresso, pedidos e IDs, mantendo as subpáginas", () => {
    expect(redactAnalyticsUrl(`${site}/ingressos/EB-ABC123`)).toBe(`${site}/ingressos/[code]`);
    expect(redactAnalyticsUrl(`${site}/pedido/cmw123`)).toBe(`${site}/pedido/[orderId]`);
    expect(redactAnalyticsUrl(`${site}/checkout/cmw123`)).toBe(`${site}/checkout/[orderId]`);
    expect(redactAnalyticsUrl(`${site}/checkout/revisao/draft9`)).toBe(`${site}/checkout/revisao/[draftId]`);
    expect(redactAnalyticsUrl(`${site}/check-in/ev1/historico`)).toBe(`${site}/check-in/[eventId]/historico`);
    expect(redactAnalyticsUrl(`${site}/organizador/eventos/ev1/assistente`)).toBe(`${site}/organizador/eventos/[id]/assistente`);
    expect(redactAnalyticsUrl(`${site}/admin/usuarios/u1`)).toBe(`${site}/admin/usuarios/[id]`);
  });

  it("não mexe em páginas públicas nem nas páginas fixas", () => {
    expect(redactAnalyticsUrl(`${site}/eventos/show-de-rock-sp`)).toBe(`${site}/eventos/show-de-rock-sp`);
    expect(redactAnalyticsUrl(`${site}/cidades/sao-paulo`)).toBe(`${site}/cidades/sao-paulo`);
    expect(redactAnalyticsUrl(`${site}/organizador/eventos/novo`)).toBe(`${site}/organizador/eventos/novo`);
    expect(redactAnalyticsUrl(`${site}/admin/usuarios`)).toBe(`${site}/admin/usuarios`);
    expect(redactAnalyticsUrl(`${site}/`)).toBe(`${site}/`);
  });

  it("remove a query (token, e-mail) e o #, mas mantém utm_*", () => {
    expect(redactAnalyticsUrl(`${site}/redefinir-senha?token=segredo`)).toBe(`${site}/redefinir-senha`);
    expect(redactAnalyticsUrl(`${site}/admin/usuarios?q=fulano%40gmail.com#x`)).toBe(`${site}/admin/usuarios`);
    expect(redactAnalyticsUrl(`${site}/eventos?utm_source=instagram&token=x&utm_campaign=lancamento`))
      .toBe(`${site}/eventos?utm_source=instagram&utm_campaign=lancamento`);
  });

  it("aceita caminho relativo e devolve relativo", () => {
    expect(redactAnalyticsUrl("/convite/abc?token=1")).toBe("/convite/[token]");
  });

  it("redactAnalyticsEvent preserva os outros campos", () => {
    expect(redactAnalyticsEvent({ type: "pageview", url: `${site}/pedido/cmw1?x=1` }))
      .toEqual({ type: "pageview", url: `${site}/pedido/[orderId]` });
  });
});
