import { expect, test } from "@playwright/test";
import { login, qrPayloadFor, USERS } from "./helpers";

test("compra com PIX simulado → ingresso com QR → check-in → leitura duplicada recusada", async ({ browser }) => {
  // Comprador
  const buyer = await (await browser.newContext()).newPage();
  await login(buyer, USERS.customer, "/eventos/festival-litoral-sonoro-rio-de-janeiro");
  await expect(buyer.getByRole("heading", { level: 1 })).toHaveText(/Festival Litoral Sonoro/);
  const lote = buyer.locator("li").filter({ hasText: "Lote promocional" });
  await lote.getByRole("button", { name: "Aumentar" }).click();
  await expect(buyer.getByText("Ingressos (1)")).toBeVisible();
  await buyer.getByRole("button", { name: "Continuar para o pagamento" }).click();

  await buyer.waitForURL(/\/checkout\//);
  await expect(buyer.getByText("Pagamento simulado.")).toBeVisible();
  await buyer.getByRole("button", { name: "Gerar PIX" }).click();
  await expect(buyer.getByText(/SIMULADO-NAO-PAGUE/)).toBeVisible();
  // Sem aprovação do provedor, o pedido continua pendente.
  const orderId = buyer.url().split("/checkout/")[1];
  await buyer.goto(`/pedido/${orderId}`);
  await expect(buyer.getByRole("heading", { name: /Aguardando confirmação/ })).toBeVisible();

  await buyer.goto(`/checkout/${orderId}`);
  await buyer.getByRole("button", { name: "Aprovar PIX" }).click();
  await buyer.waitForURL(/\/pedido\//);
  await expect(buyer.getByRole("heading", { name: "Pagamento confirmado!" })).toBeVisible();

  const ticketLink = buyer.locator('a[href^="/ingressos/"]').first();
  const code = (await ticketLink.getAttribute("href"))!.split("/").pop()!;
  await ticketLink.click();
  await expect(buyer.getByRole("img", { name: "QR code do ingresso" })).toBeVisible();
  await expect(buyer.getByText(code)).toBeVisible();

  // Organizador valida na entrada
  const staff = await (await browser.newContext()).newPage();
  const { payload, eventId } = await qrPayloadFor(code);
  await login(staff, USERS.producer, `/check-in/${eventId}`);
  await expect(staff).toHaveURL(new RegExp(`/check-in/${eventId}`));
  const input = staff.getByPlaceholder(/Colar conteúdo do QR/);
  await input.fill(payload);
  await staff.getByRole("button", { name: "Validar" }).click();
  // O anunciador de rotas do Next também usa role=alert: filtramos pelo texto do resultado.
  const result = (text: string) => staff.getByRole("alert").filter({ hasText: text });
  await expect(result("Entrada liberada")).toBeVisible();
  await expect(result("Entrada liberada")).toContainText(code);
  await staff.waitForTimeout(2600);
  await input.fill(payload);
  await staff.getByRole("button", { name: "Validar" }).click();
  await expect(result("Ingresso JÁ UTILIZADO")).toBeVisible();

  // O comprador vê o ingresso como utilizado
  await buyer.reload();
  await expect(buyer.getByText("Ingresso já utilizado")).toBeVisible();
});

test("meia-entrada: a portaria vê o aviso para exigir o documento, também no duplicado", async ({ browser }) => {
  const buyer = await (await browser.newContext()).newPage();
  await login(buyer, USERS.customer, "/eventos/festival-litoral-sonoro-rio-de-janeiro");
  const meia = buyer.locator("li").filter({ hasText: "Meia-entrada" });
  await meia.getByRole("button", { name: "Aumentar" }).click();
  await buyer.getByRole("checkbox", { name: /direito à meia-entrada/ }).check();
  await buyer.getByRole("button", { name: "Continuar para o pagamento" }).click();
  await buyer.waitForURL(/\/checkout\//);
  await buyer.getByRole("button", { name: "Gerar PIX" }).click();
  await buyer.getByRole("button", { name: "Aprovar PIX" }).click();
  await buyer.waitForURL(/\/pedido\//);
  const code = (await buyer.locator('a[href^="/ingressos/"]').first().getAttribute("href"))!.split("/").pop()!;

  const staff = await (await browser.newContext()).newPage();
  const { payload, eventId } = await qrPayloadFor(code);
  await login(staff, USERS.producer, `/check-in/${eventId}`);
  const input = staff.getByPlaceholder(/Colar conteúdo do QR/);
  const result = (text: string) => staff.getByRole("alert").filter({ hasText: text });
  await input.fill(payload);
  await staff.getByRole("button", { name: "Validar" }).click();
  await expect(result("Entrada liberada")).toContainText("Meia-entrada — exigir documento comprobatório");
  await staff.waitForTimeout(2600);
  await input.fill(payload);
  await staff.getByRole("button", { name: "Validar" }).click();
  await expect(result("Ingresso JÁ UTILIZADO")).toContainText("Meia-entrada — exigir documento comprobatório");
});
