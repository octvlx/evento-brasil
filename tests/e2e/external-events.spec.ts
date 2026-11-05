import "dotenv/config";
import { test, expect } from "@playwright/test";
import pg from "pg";
import { login, USERS } from "./helpers";

// Evento externo publicado (inserido direto no banco descartável, como faria a importação
// revisada): página própria com "Evento externo", fonte e saída para o site oficial;
// aparece na busca e na cidade, separado dos eventos vendidos aqui.
const SLUG = `baile-de-teste-externo-duoticket-e2e${Date.now().toString(36)}`;
const TITLE = "Baile de Teste Externo";

test.describe("eventos externos", () => {
  test.skip(process.env.E2E_ISOLATED !== "1", "Insere evento externo: só no banco descartável do E2E isolado.");

  test.beforeAll(async () => {
    const client = new pg.Client({ connectionString: process.env.DATABASE_URL });
    await client.connect();
    const { rows } = await client.query(`SELECT id FROM "City" WHERE slug = 'sao-paulo-sp'`);
    const starts = new Date(Date.now() + 10 * 86_400_000);
    starts.setUTCHours(3, 0, 0, 0);
    await client.query(
      `INSERT INTO "ExternalEvent" (id, "sourceId", "sourceEventId", "sourceUrl", slug, title, "startsAt", "hasTime", timezone, "venueName", "cityName", state, "cityId", review, "isFeatured", "contentHash", "publishedAt", "updatedAt")
       VALUES ($1, 'extsrc_duoticket', $2, $3, $4, $5, $6, false, 'America/Sao_Paulo', 'Salão de Testes', 'São Paulo', 'SP', $7, 'PUBLISHED', true, 'e2e', now(), now())`,
      [`ext_${SLUG}`.slice(0, 30), SLUG.slice(-12), `https://duoticket.com.br/evento/999999/${SLUG}`, SLUG, TITLE, starts, rows[0]?.id ?? null],
    );
    await client.end();
  });

  test("página do evento externo, busca e cidade mostram a fonte e levam ao site oficial", async ({ page }) => {
    await page.goto(`/eventos-externos/${SLUG}`);
    await expect(page.getByRole("heading", { level: 1, name: TITLE })).toBeVisible();
    await expect(page.getByText("Evento externo", { exact: true }).first()).toBeVisible();
    await expect(page.getByText("Ingressos na Duoticket").first()).toBeVisible();
    await expect(page.getByText("Horário não informado pela fonte.")).toBeVisible();
    await expect(page.getByText("Preço não informado aqui: confira no site oficial.")).toBeVisible();
    await expect(page.getByText(/não organiza este evento, não vende os ingressos/)).toBeVisible();
    const cta = page.getByRole("link", { name: /Ver ingressos no site oficial/ });
    await expect(cta).toHaveAttribute("href", `/eventos-externos/${SLUG}/ir`);
    await expect(cta).toHaveAttribute("target", "_blank");
    // Sem checkout interno: nada de "Continuar para revisão" nem seletor de ingressos.
    await expect(page.getByRole("button", { name: "Continuar para revisão" })).toHaveCount(0);

    // A saída redireciona para a URL original (sem seguir para o site de terceiros).
    const res = await page.request.get(`/eventos-externos/${SLUG}/ir`, { maxRedirects: 0 });
    expect(res.status()).toBe(303);
    expect(res.headers()["location"]).toBe(`https://duoticket.com.br/evento/999999/${SLUG}`);

    await page.goto(`/eventos?q=${encodeURIComponent("Baile de Teste")}`);
    const section = page.getByRole("region", { name: /ingressos em outros sites/ });
    await expect(section.getByRole("link", { name: new RegExp(TITLE) })).toHaveAttribute("href", `/eventos-externos/${SLUG}`);

    // Destaque externo na home: junto dos nativos, leva ao link externo (pela saída /ir).
    await page.goto("/");
    await expect(page.getByRole("link", { name: new RegExp(`${TITLE} — evento externo`) }).first()).toHaveAttribute("href", `/eventos-externos/${SLUG}/ir`);

    await page.goto("/cidades/sao-paulo-sp");
    await expect(page.getByRole("region", { name: /Também em São Paulo/ }).getByText(TITLE)).toBeVisible();
  });

  test("admin vê as fontes com a situação de cada uma", async ({ page }) => {
    await login(page, USERS.admin, "/admin/eventos-externos");
    await page.waitForURL(/\/admin\/eventos-externos/);
    await expect(page.getByRole("heading", { level: 1, name: "Eventos externos" })).toBeVisible();
    const sympla = page.getByRole("listitem").filter({ hasText: "sympla.com.br" });
    await expect(sympla.getByText("Precisa de autorização")).toBeVisible();
    await expect(sympla.getByRole("button", { name: "Ativar" })).toHaveCount(0);
    await expect(page.getByRole("listitem").filter({ hasText: "duoticket.com.br" }).getByRole("button", { name: "Ativar" })).toBeVisible();
  });
});
