import { expect, test } from "@playwright/test";
import { acceptSignupTerms, login, USERS, confirmEmail } from "./helpers";

test("novo organizador se cadastra → admin aprova pela fila", async ({ browser }) => {
  const stamp = Date.now();
  const orgName = `Produtora E2E ${stamp}`;

  const owner = await (await browser.newContext()).newPage();
  await owner.goto("/registrar?next=/organizador/cadastro");
  await owner.getByLabel("Nome completo").fill("Pessoa Teste E2E");
  await owner.getByLabel("E-mail", { exact: true }).fill(`e2e+${stamp}@test.local`);
  await owner.getByLabel("Confirmar e-mail", { exact: true }).fill(`e2e+${stamp}@test.local`);
  await owner.getByLabel("Senha", { exact: true }).fill("Cadastro#E2e2468");
  await owner.getByLabel("Confirmar senha", { exact: true }).fill("Cadastro#E2e2468");
  await acceptSignupTerms(owner);
  await owner.getByRole("button", { name: "Criar conta" }).click();
  // Conta nova confirma o e-mail antes de seguir para o cadastro de organizador.
  await owner.waitForURL(/\/confirmar-email/);
  await confirmEmail(owner, `e2e+${stamp}@test.local`);
  await owner.goto("/organizador/cadastro");

  await owner.getByLabel("Nome público").fill(orgName);
  await owner.getByLabel("Razão social").fill(`${orgName} LTDA`);
  await owner.getByLabel("CNPJ", { exact: true }).fill("11.111.111/1111-11");
  await owner.getByRole("button", { name: "Enviar para análise" }).click();
  await expect(owner.getByText("CNPJ inválido")).toBeVisible();
  await owner.getByLabel("CNPJ", { exact: true }).fill("11.222.333/0001-81");
  await owner.getByRole("button", { name: "Enviar para análise" }).click();
  await owner.waitForURL(/\/organizador$/);
  await expect(owner.getByText("Cadastro: Em análise")).toBeVisible();

  const admin = await (await browser.newContext()).newPage();
  await login(admin, USERS.admin, "/admin/organizadores");
  const row = admin.locator("li").filter({ hasText: orgName });
  await expect(row).toContainText("Em análise");
  await expect(row).toContainText("CNPJ final 0181");
  await row.getByRole("button", { name: "Aprovar" }).click();
  await expect(admin.locator("li").filter({ hasText: orgName })).toContainText("Aprovada");

  await owner.reload();
  await expect(owner.getByText("Cadastro: Aprovada")).toBeVisible();
});
