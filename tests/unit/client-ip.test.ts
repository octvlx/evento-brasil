import { describe, expect, it } from "vitest";
import { clientIpFromHeaders } from "@/server/client-ip";

const h = (init: Record<string, string>) => new Headers(init);

describe("clientIpFromHeaders", () => {
  it("Vercel: um único IP no x-forwarded-for", () => {
    expect(clientIpFromHeaders(h({ "x-forwarded-for": "203.0.113.7" }))).toBe("203.0.113.7");
  });

  it("Cloud Run direto: ignora o que o cliente forjou à esquerda", () => {
    // O cliente mandou "1.1.1.1, 2.2.2.2"; o Google acrescentou o IP real no fim.
    const forged = h({ "x-forwarded-for": "1.1.1.1, 2.2.2.2, 203.0.113.7" });
    expect(clientIpFromHeaders(forged)).toBe("203.0.113.7");
  });

  it("forjar um IP diferente a cada tentativa não muda a chave do limite", () => {
    const a = clientIpFromHeaders(h({ "x-forwarded-for": "10.0.0.1, 203.0.113.7" }));
    const b = clientIpFromHeaders(h({ "x-forwarded-for": "10.0.0.2, 203.0.113.7" }));
    expect(a).toBe(b);
  });

  it("Load Balancer na frente: pula os proxies confiáveis", () => {
    const viaLb = h({ "x-forwarded-for": "1.1.1.1, 203.0.113.7, 34.120.0.1" });
    expect(clientIpFromHeaders(viaLb, 1)).toBe("203.0.113.7");
  });

  it("menos entradas que o esperado: usa a mais à esquerda", () => {
    expect(clientIpFromHeaders(h({ "x-forwarded-for": "203.0.113.7" }), 2)).toBe("203.0.113.7");
  });

  it("ignora espaços e entradas vazias", () => {
    expect(clientIpFromHeaders(h({ "x-forwarded-for": " 1.1.1.1 , 203.0.113.7 , " }))).toBe("203.0.113.7");
  });

  it("sem x-forwarded-for usa x-real-ip; sem nenhum, null", () => {
    expect(clientIpFromHeaders(h({ "x-real-ip": "198.51.100.4" }))).toBe("198.51.100.4");
    expect(clientIpFromHeaders(h({}))).toBeNull();
  });

  it("limita o tamanho do valor guardado", () => {
    const ip = clientIpFromHeaders(h({ "x-forwarded-for": "x".repeat(500) }));
    expect(ip).toHaveLength(64);
  });
});
