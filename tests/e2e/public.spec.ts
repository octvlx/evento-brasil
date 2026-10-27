import { expect, test } from "@playwright/test";
import { createCouponLink, login, USERS } from "./helpers";

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

test("link rastreado → cupom pré-aplicado → pedido com desconto", async ({ page }) => {
  const { couponCode, linkCode } = await createCouponLink("noite-de-samba-no-terraco-sao-paulo");
  await login(page, USERS.customer, "/meus-ingressos");
  // Clique no link vindo de fora (rede social): carregamento completo da página.
  await page.goto(`/r/${linkCode}`);
  await expect(page).toHaveURL(/\/eventos\/noite-de-samba-no-terraco/);

  const coupon = page.getByLabel("Cupom de desconto");
  await expect(coupon).toHaveValue(couponCode);
  await page.locator("li").filter({ hasText: "Inteira" }).getByRole("button", { name: "Aumentar" }).click();

  // Erro do serviço aparece junto ao campo; o comprador pode trocar ou remover o cupom.
  await coupon.fill("NAOEXISTE");
  await page.getByRole("button", { name: "Continuar para o pagamento" }).click();
  await expect(page.getByRole("alert").filter({ hasText: "Cupom inválido ou indisponível." })).toBeVisible();
  await expect(coupon).toHaveAttribute("aria-invalid", "true");

  await coupon.fill(couponCode.toLowerCase());
  await page.getByRole("button", { name: "Continuar para o pagamento" }).click();
  await page.waitForURL(/\/checkout\//);
  // O Next mantém a página anterior oculta no DOM: só o resumo visível.
  const summary = page.locator("dl:visible").filter({ hasText: "Subtotal" });
  await expect(summary).toContainText("1× Inteira");
  await expect(summary).toContainText("R$ 80,00");
  await expect(summary).toContainText(`Desconto · cupom ${couponCode}`);
  await expect(summary).toContainText("−R$ 8,00");
  await expect(summary.locator("div").filter({ hasText: "Subtotal" })).toContainText("R$ 72,00");

  await page.getByRole("button", { name: "Gerar PIX" }).click();
  await page.getByRole("button", { name: "Aprovar PIX" }).click();
  await page.waitForURL(/\/pedido\//);
  await expect(page.getByRole("heading", { name: "Pagamento confirmado!" })).toBeVisible();
  await expect(page.locator("dl:visible").filter({ hasText: "Subtotal" })).toContainText(`Desconto · cupom ${couponCode}`);
});
