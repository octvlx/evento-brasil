import { describe, expect, it } from "vitest";
import nextConfig, { contentSecurityPolicy, securityHeaders } from "../../next.config";

const header = (key: string) => securityHeaders.find((h) => h.key === key)?.value;

describe("cabeçalhos de segurança", () => {
  it("valem para todas as rotas", async () => {
    expect(await nextConfig.headers!()).toEqual([{ source: "/:path*", headers: securityHeaders }]);
  });

  it("CSP: scripts só da própria origem e da medição de anúncios (Meta e Google), iframes só do Google Ads e o OAuth do Mercado Pago em form-action", () => {
    const directives = Object.fromEntries(contentSecurityPolicy.split("; ").map((d) => [d.split(" ")[0], d]));
    expect(directives["default-src"]).toBe("default-src 'self'");
    expect(directives["script-src"]).toBe("script-src 'self' 'unsafe-inline' https://connect.facebook.net https://www.googletagmanager.com");
    expect(directives["frame-src"]).toBe("frame-src https://www.googletagmanager.com https://td.doubleclick.net");
    expect(directives["connect-src"]).toMatch(/^connect-src 'self' /);
    expect(directives["connect-src"]).toContain("https://www.facebook.com");
    // Sem curinga genérico: só os domínios listados.
    expect(directives["connect-src"].split(" ")).not.toContain("https:");
    expect(directives["connect-src"].split(" ")).not.toContain("*");
    expect(directives["object-src"]).toBe("object-src 'none'");
    expect(directives["frame-ancestors"]).toBe("frame-ancestors 'none'");
    expect(directives["form-action"]).toContain("https://auth.mercadopago.com.br");
    expect(contentSecurityPolicy).toContain("upgrade-insecure-requests");
  });

  it("anti-clickjacking, nosniff, referrer, câmera só na própria origem e HSTS fora do dev", () => {
    expect(header("X-Frame-Options")).toBe("DENY");
    expect(header("X-Content-Type-Options")).toBe("nosniff");
    expect(header("Referrer-Policy")).toBe("strict-origin-when-cross-origin");
    expect(header("Permissions-Policy")).toContain("camera=(self)");
    expect(header("Permissions-Policy")).toContain("microphone=()");
    // "Usar minha localização" na home: só a própria origem pode pedir.
    expect(header("Permissions-Policy")).toContain("geolocation=(self)");
    expect(header("Strict-Transport-Security")).toBe("max-age=63072000; includeSubDomains");
  });
});
