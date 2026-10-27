import { randomUUID } from "node:crypto";
import { expect, test } from "@playwright/test";
import pg from "pg";
import { login, USERS } from "./helpers";

/**
 * Regra de comissão do evento com taxa paga pelo comprador (o seed só tem a
 * da plataforma, paga pelo organizador). Devolve uma função que a encerra.
 */
async function withBuyerFee(slug: string, percentBps: number, fixedCents: number) {
  const client = new pg.Client({ connectionString: process.env.DATABASE_URL });
  await client.connect();
  const { rows } = await client.query('SELECT id FROM "Event" WHERE slug = $1', [slug]);
  expect(rows[0], `evento ${slug}`).toBeTruthy();
  const eventId = rows[0].id as string;
  const id = `e2e-${randomUUID()}`;
  await client.query(`UPDATE "CommissionRule" SET "activeTo" = now() WHERE scope = 'EVENT' AND "eventId" = $1 AND "activeTo" IS NULL`, [eventId]);
  await client.query(
    `INSERT INTO "CommissionRule" (id, scope, "eventId", "percentBps", "fixedCentsPerTicket", bearer, "policyVersion", "activeFrom")
     VALUES ($1, 'EVENT', $2, $3, $4, 'BUYER', $5, now() - interval '1 minute')`,
    [id, eventId, percentBps, fixedCents, `${id}:v1`],
  );
  return async () => {
    await client.query('UPDATE "CommissionRule" SET "activeTo" = now() WHERE id = $1', [id]);
    await client.end();
  };
}

test("visitante descobre eventos publicados sem login", async ({ page }) => {
  await page.goto("/");
  await expect(page.getByRole("heading", { level: 1 })).toContainText("viver");
  await expect(page.getByRole("heading", { name: "Em destaque" })).toBeVisible();
  const cards = page.locator('a[href^="/eventos/"]').filter({ has: page.locator("h3") });
  await expect(cards.first()).toBeVisible();
  // Cada card mostra data, título, local e preço.
  await expect(cards.first()).toContainText(/R\$|Gratuito/);
});

test("busca por cidade e abre o detalhe do evento", async ({ page }) => {
  await page.goto("/eventos?cidade=salvador-ba");
  await expect(page.getByText(/eventos? encontrados?/)).toBeVisible();
  await page.getByRole("link", { name: /Axé de Rua/ }).click();
  await expect(page.getByRole("heading", { level: 1 })).toHaveText(/Axé de Rua/);
  // Trilha Início › cidade › categoria, com o título como página atual.
  const trail = page.getByRole("navigation", { name: "Trilha de navegação" });
  await expect(trail.getByRole("link", { name: "Salvador" })).toHaveAttribute("href", "/cidades/salvador-ba");
  await expect(trail.locator('[aria-current="page"]')).toHaveText(/Axé de Rua/);
  const ldTypes = await page.locator('script[type="application/ld+json"]').evaluateAll((els) => els.map((e) => JSON.parse(e.textContent ?? "{}")["@type"]));
  expect(ldTypes).toEqual(expect.arrayContaining(["Event", "BreadcrumbList"]));
  await expect(page.getByText("Entrada gratuita")).toBeVisible();
  await expect(page.getByText("Sem taxa para o comprador")).toBeVisible();
  await expect(page.getByRole("link", { name: /WhatsApp/ })).toHaveAttribute("href", /wa\.me/);
});

test("página de cidade e 404 para evento inexistente", async ({ page }) => {
  await page.goto("/cidades/franca-sp");
  await expect(page.getByRole("heading", { level: 1 })).toHaveText("Eventos em Franca");
  await expect(page.getByText(/Corrida Noturna/)).toBeVisible();
  // Vitrine: uma faixa por categoria; as abas de data filtram e mantêm a URL.
  await expect(page.getByRole("heading", { level: 2, name: /Esportes/ })).toBeVisible();
  await page.getByRole("navigation", { name: "Quando" }).getByRole("link", { name: "Fim de semana" }).click();
  await expect(page).toHaveURL(/\/cidades\/franca-sp\?data=fim-de-semana/);
  await expect(page.getByRole("link", { name: "Fim de semana" })).toHaveAttribute("aria-current", "page");
  await expect(page.getByText(/eventos? encontrados?/)).toBeVisible();
  // Com streaming (Cache Components), notFound() dentro de Suspense ocorre após o
  // envio dos cabeçalhos: o status fica 200, mas a UI de 404 e o noindex são aplicados.
  await page.goto("/eventos/nao-existe-xyz");
  await expect(page.getByRole("heading", { name: "Página não encontrada" })).toBeVisible();
  await expect(page.locator('meta[name="robots"][content*="noindex"]').first()).toBeAttached();
});

test("reembolso: pedido mostra a situação e os ingressos ficam cancelados com o motivo", async ({ page }) => {
  await login(page, USERS.customer, "/eventos/festival-litoral-sonoro-rio-de-janeiro");
  await page.locator("li").filter({ hasText: "Lote promocional" }).getByRole("button", { name: "Aumentar" }).click();
  await page.getByRole("button", { name: "Continuar para o pagamento" }).click();
  await page.waitForURL(/\/checkout\//);
  await page.getByRole("button", { name: "Gerar PIX" }).click();
  await page.getByRole("button", { name: "Aprovar PIX" }).click();
  await page.waitForURL(/\/pedido\//);
  await expect(page.getByRole("heading", { name: "Pagamento confirmado!" })).toBeVisible();
  const orderUrl = page.url();

  // O checkout de um pedido pago leva de volta ao pedido (não oferece novo pagamento).
  await page.goto(orderUrl.replace("/pedido/", "/checkout/"));
  await page.waitForURL(/\/pedido\//);

  await page.getByRole("button", { name: "Solicitar reembolso" }).click();
  await page.getByRole("button", { name: "Sim, reembolsar" }).click();
  await expect(page.getByRole("status").filter({ hasText: "Reembolso concluído." }).first()).toBeVisible();
  await expect(page.getByText("Cancelado por reembolso do pedido").first()).toBeVisible();
  await expect(page.getByRole("button", { name: "Solicitar reembolso" })).toHaveCount(0);

  await page.locator('a[href^="/ingressos/"]').first().click();
  await expect(page.getByText("Cancelado por reembolso do pedido")).toBeVisible();
  await expect(page.getByRole("img", { name: "QR code do ingresso" })).toHaveCount(0);

  await page.goto("/meus-ingressos");
  const row = page.getByRole("row").filter({ has: page.locator(`a[href="${new URL(orderUrl).pathname}"]`) });
  await expect(row).toContainText("Reembolsado");
});

test("robots.txt e sitemap.xml públicos", async ({ request }) => {
  const robots = await request.get("/robots.txt");
  expect(robots.status()).toBe(200);
  const robotsText = await robots.text();
  expect(robotsText).toContain("Disallow: /checkout");
  expect(robotsText).toContain("sitemap.xml");
  const sitemap = await request.get("/sitemap.xml");
  expect(sitemap.status()).toBe(200);
  const xml = await sitemap.text();
  expect(xml).toContain("/eventos</loc>");
  expect(xml).toContain("/cidades/");
  // Só cidades com evento publicado: Franca tem a Corrida Noturna; cidades sem eventos ficam de fora.
  expect(xml).toContain("/cidades/franca-sp</loc>");
  expect(xml).not.toMatch(/\/admin|\/checkout|\/pedido\//);
  // Páginas que definem openGraph próprio mantêm a imagem de compartilhamento padrão.
  const eventos = await (await request.get("/eventos")).text();
  expect(eventos).toMatch(/<meta property="og:image" content="[^"]*\/opengraph-image/);
});

test.describe("preço total com taxa (Decreto 13.108/2026)", () => {
  const slug = "workshop-de-fotografia-urbana-curitiba";
  let restore: () => Promise<void>;
  // R$ 150,00 + 10% + R$ 1,50 = R$ 166,50 por ingresso.
  test.beforeAll(async () => {
    restore = await withBuyerFee(slug, 1000, 150);
  });
  test.afterAll(async () => {
    await restore?.();
  });

  test("card, página do evento e checkout mostram o mesmo total com a taxa discriminada", async ({ page }) => {
    await login(page, USERS.customer, "/eventos?cidade=curitiba-pr");
    const card = page.locator(`a[href="/eventos/${slug}"]`);
    const price = card.getByTestId("card-price");
    await expect(price).toContainText(/A partir de R\$\s166,50/);
    await expect(price).toContainText(/\(R\$\s150,00 \+ R\$\s16,50 de taxa\)/);

    await card.click();
    const ticket = page.locator("li").filter({ hasText: "Participante" });
    await expect(ticket.getByTestId("ticket-total")).toHaveText(/R\$\s166,50/);
    await expect(ticket).toContainText(/R\$\s150,00 \+ R\$\s16,50 de taxa de serviço/);
    await ticket.getByRole("button", { name: "Aumentar" }).click();
    await page.getByRole("button", { name: "Continuar para o pagamento" }).click();
    await page.waitForURL(/\/checkout\//);
    const total = page.locator("dl div").filter({ has: page.getByText("Total", { exact: true }) }).last();
    await expect(total).toContainText(/R\$\s166,50/);

    // Pedido pendente: o canal de cancelamento aparece; cancela para liberar a reserva.
    await page.goto(page.url().replace("/checkout/", "/pedido/"));
    await expect(page.getByRole("link", { name: /Cancelar compra \/ arrependimento/ })).toHaveAttribute("href", "/ajuda#cancelamento");
    await page.getByRole("button", { name: "Cancelar pedido" }).click();
    await expect(page.getByRole("button", { name: "Cancelar pedido" })).toHaveCount(0);
  });
});

test("canal de cancelamento/arrependimento: rodapé, Meus ingressos e Central de ajuda", async ({ page }) => {
  await page.goto("/");
  const footerLink = page.getByRole("contentinfo").getByRole("link", { name: "Cancelar compra / arrependimento" });
  await expect(footerLink).toHaveAttribute("href", "/ajuda#cancelamento");
  await footerLink.click();
  await expect(page).toHaveURL(/\/ajuda#cancelamento$/);
  const section = page.getByRole("heading", { name: "Cancelar compra / arrependimento" });
  await expect(section).toBeVisible();
  await expect(page.getByText(/pago há no máximo 7 dias/)).toBeVisible();
  await expect(page.getByText(/pelo menos 48 horas/)).toBeVisible();
  await expect(page.getByText(/revisão jurídica/)).toBeVisible();

  await login(page, USERS.customer, "/meus-ingressos");
  await expect(page.getByRole("link", { name: "Cancelar compra / arrependimento" }).first()).toHaveAttribute("href", "/ajuda#cancelamento");
});
