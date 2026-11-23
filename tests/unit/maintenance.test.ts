import { describe, expect, it } from "vitest";
import { NextRequest } from "next/server";
import {
  MAINTENANCE_PREVIEW_COOKIE,
  maintenanceConfig,
  maintenanceDecision,
  signMaintenancePreview,
  verifyMaintenancePreview,
} from "@/server/maintenance";

describe("prévia da equipe", () => {
  const secret = "s".repeat(32);
  const now = new Date("2026-11-23T12:00:00Z");
  const inOneHour = new Date(now.getTime() + 3_600_000);

  it("aceita o cookie assinado e válido", () => {
    expect(verifyMaintenancePreview(signMaintenancePreview("u1", inOneHour, secret), secret, now)).toBe(true);
  });

  it("recusa cookie vencido, com outro segredo, adulterado ou longo demais", () => {
    const ok = signMaintenancePreview("u1", inOneHour, secret);
    expect(verifyMaintenancePreview(signMaintenancePreview("u1", new Date(now.getTime() - 1), secret), secret, now)).toBe(false);
    expect(verifyMaintenancePreview(ok, "x".repeat(32), now)).toBe(false);
    expect(verifyMaintenancePreview(ok.replace("u1.", "u2."), secret, now)).toBe(false);
    const [u, , sig] = ok.split(".");
    expect(verifyMaintenancePreview(`${u}.${inOneHour.getTime() + 1}.${sig}`, secret, now)).toBe(false);
    const tooLong = new Date(now.getTime() + 9 * 3_600_000);
    expect(verifyMaintenancePreview(signMaintenancePreview("u1", tooLong, secret), secret, now)).toBe(false);
    expect(verifyMaintenancePreview(`${ok}.extra`, secret, now)).toBe(false);
    expect(verifyMaintenancePreview(undefined, secret, now)).toBe(false);
    expect(verifyMaintenancePreview(ok, undefined, now)).toBe(false);
  });
});

const on = { enabled: true, allowCheckin: true };

describe("maintenanceConfig", () => {
  it("só liga com MAINTENANCE_MODE=true; a portaria fica liberada por padrão", () => {
    expect(maintenanceConfig({})).toEqual({ enabled: false, allowCheckin: true });
    expect(maintenanceConfig({ MAINTENANCE_MODE: "1" }).enabled).toBe(false);
    expect(maintenanceConfig({ MAINTENANCE_MODE: "true" }).enabled).toBe(true);
    expect(maintenanceConfig({ MAINTENANCE_ALLOW_CHECKIN: "false" }).allowCheckin).toBe(false);
  });
});

describe("maintenanceDecision", () => {
  it("desligado, tudo segue", () => {
    expect(maintenanceDecision("/", { enabled: false, allowCheckin: true })).toBe("open");
    expect(maintenanceDecision("/api/orders", { enabled: false, allowCheckin: true })).toBe("open");
  });

  it("ligado, páginas e APIs comuns param", () => {
    for (const p of ["/", "/eventos", "/eventos/show-x", "/checkout/abc", "/registrar", "/organizador", "/minha-conta"]) {
      expect(maintenanceDecision(p, on)).toBe("page");
    }
    for (const p of ["/api/orders", "/api/busca/sugestoes", "/api/tickets/X/pdf", "/api"]) {
      expect(maintenanceDecision(p, on)).toBe("api");
    }
  });

  it("dinheiro em trânsito, cron e acesso da equipe continuam", () => {
    for (const p of [
      "/api/webhooks/mercadopago",
      "/api/cron/maintenance",
      "/api/cron/health",
      "/api/mercadopago/callback",
      "/admin",
      "/admin/usuarios",
      "/entrar",
      "/entrar/verificacao",
      "/auth/google/callback",
      "/minha-conta/seguranca",
    ]) {
      expect(maintenanceDecision(p, on)).toBe("open");
    }
  });

  it("prefixo não vaza para rotas parecidas", () => {
    expect(maintenanceDecision("/administrador", on)).toBe("page");
    expect(maintenanceDecision("/entrarx", on)).toBe("page");
    expect(maintenanceDecision("/check-inx", on)).toBe("page");
    expect(maintenanceDecision("/api/webhooksx", on)).toBe("api");
  });

  it("portaria liberada por padrão e bloqueável", () => {
    expect(maintenanceDecision("/check-in/evt1", on)).toBe("open");
    expect(maintenanceDecision("/check-in/evt1", { enabled: true, allowCheckin: false })).toBe("page");
  });
});

describe("proxy", () => {
  it("responde 503 com tela em pt-BR, JSON nas APIs, e deixa passar o webhook", async () => {
    process.env.MAINTENANCE_MODE = "true";
    try {
      const { proxy } = await import("@/proxy");
      const page = proxy(new NextRequest("https://ticket24.com.br/eventos"));
      expect(page.status).toBe(503);
      expect(page.headers.get("retry-after")).toBe("1800");
      expect(await page.text()).toContain("Estamos em manutenção");

      const api = proxy(new NextRequest("https://ticket24.com.br/api/orders", { method: "POST" }));
      expect(api.status).toBe(503);
      expect(await api.json()).toMatchObject({ error: "MAINTENANCE" });

      const webhook = proxy(new NextRequest("https://ticket24.com.br/api/webhooks/mercadopago", { method: "POST" }));
      expect(webhook.headers.get("x-middleware-next")).toBe("1");
    } finally {
      delete process.env.MAINTENANCE_MODE;
    }
  });

  it("deixa passar quem tem a prévia da equipe, e só com o cookie válido", async () => {
    process.env.MAINTENANCE_MODE = "true";
    const previousSecret = process.env.AUTH_SECRET;
    process.env.AUTH_SECRET = "p".repeat(32);
    try {
      const { proxy } = await import("@/proxy");
      const valid = signMaintenancePreview("admin1", new Date(Date.now() + 3_600_000), process.env.AUTH_SECRET);
      const withCookie = (value: string, path = "/eventos") =>
        proxy(new NextRequest(`https://ticket24.com.br${path}`, { headers: { cookie: `${MAINTENANCE_PREVIEW_COOKIE}=${value}` } }));

      expect(withCookie(valid).headers.get("x-middleware-next")).toBe("1");
      expect(withCookie(valid, "/api/orders").headers.get("x-middleware-next")).toBe("1");
      expect(withCookie(`${valid}x`).status).toBe(503);
    } finally {
      delete process.env.MAINTENANCE_MODE;
      if (previousSecret === undefined) delete process.env.AUTH_SECRET;
      else process.env.AUTH_SECRET = previousSecret;
    }
  });
});
