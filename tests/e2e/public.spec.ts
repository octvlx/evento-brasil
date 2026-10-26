import { expect, test } from "@playwright/test";

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
  await expect(page.getByText("Entrada gratuita")).toBeVisible();
  await expect(page.getByText("Sem taxa para o comprador")).toBeVisible();
  await expect(page.getByRole("link", { name: /WhatsApp/ })).toHaveAttribute("href", /wa\.me/);
});

test("página de cidade e 404 para evento inexistente", async ({ page }) => {
  await page.goto("/cidades/franca-sp");
  await expect(page.getByRole("heading", { level: 1 })).toHaveText("Eventos em Franca");
  await expect(page.getByText(/Corrida Noturna/)).toBeVisible();
  // Com streaming (Cache Components), notFound() dentro de Suspense ocorre após o
  // envio dos cabeçalhos: o status fica 200, mas a UI de 404 e o noindex são aplicados.
  await page.goto("/eventos/nao-existe-xyz");
  await expect(page.getByRole("heading", { name: "Página não encontrada" })).toBeVisible();
  await expect(page.locator('meta[name="robots"][content*="noindex"]').first()).toBeAttached();
});
