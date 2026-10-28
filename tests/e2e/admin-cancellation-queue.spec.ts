import { expect, test } from "@playwright/test";
import { login, USERS } from "./helpers";

const NEW_ROUTES = ["/admin/cancelamentos", "/admin/transferencias", "/admin/alteracoes", "/admin/auditoria?grupo=cancellation"];

test("cliente não acessa as filas novas do admin", async ({ page }) => {
  await login(page, USERS.customer);
  for (const route of NEW_ROUTES) {
    await page.goto(route);
    await expect(page, route).toHaveURL(/^https?:\/\/[^/]+\/$/);
  }
});

test("admin aprova o pedido de cancelamento do seed com motivo obrigatório", async ({ page }) => {
  await login(page, USERS.admin, "/admin/cancelamentos");
  await page.goto("/admin/cancelamentos");
  const link = page.getByRole("link", { name: /^CAN-\d{8}-SEED01$/ });
  await expect(link).toBeVisible();
  await link.click();
  await expect(page.getByRole("heading", { name: /Protocolo CAN-\d{8}-SEED01/ })).toBeVisible();
  await expect(page.getByText("Não poderei comparecer na data do festival (demonstração).")).toBeVisible();

  await page.getByRole("button", { name: "Aprovar", exact: true }).click();
  const dialog = page.getByRole("dialog");
  const confirm = dialog.getByRole("button", { name: "Confirmar: aprovar" });
  await expect(confirm).toBeDisabled(); // motivo obrigatório
  await dialog.getByLabel("Justificativa da aprovação").fill("Dentro do prazo de arrependimento (e2e).");
  // Duplo clique: o botão trava no primeiro e o serviço decide uma única vez.
  await confirm.dblclick();
  // A página é atualizada pela ação: o quadro de decisão some e o status muda.
  await expect(page.getByText("Aprovado", { exact: true })).toBeVisible();
  await page.reload();
  await expect(page.getByText("Aprovado", { exact: true })).toBeVisible();
  await expect(page.getByText("deste protocolo")).toHaveCount(1);
  await expect(page.getByRole("button", { name: "Aprovar", exact: true })).toHaveCount(0);

  await page.goto("/admin/auditoria?grupo=cancellation");
  await expect(page.getByRole("cell", { name: "cancellation.approved" })).toHaveCount(1);
});
