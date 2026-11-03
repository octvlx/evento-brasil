import { describe, expect, it } from "vitest";
import nextConfig, { contentSecurityPolicy, securityHeaders } from "../../next.config";

const header = (key: string) => securityHeaders.find((h) => h.key === key)?.value;

describe("cabeçalhos de segurança", () => {
  it("valem para todas as rotas", async () => {
    expect(await nextConfig.headers!()).toEqual([{ source: "/:path*", headers: securityHeaders }]);
  });

  it("CSP: só a própria origem para scripts, sem iframe de terceiros e com o OAuth do Mercado Pago liberado em form-action", () => {
    const directives = Object.fromEntries(contentSecurityPolicy.split("; ").map((d) => [d.split(" ")[0], d]));
    expect(directives["default-src"]).toBe("default-src 'self'");
    expect(directives["script-src"]).toBe("script-src 'self' 'unsafe-inline'");
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
    expect(header("Strict-Transport-Security")).toBe("max-age=63072000; includeSubDomains");
  });
});
