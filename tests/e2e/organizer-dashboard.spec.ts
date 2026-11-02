import { expect, test } from "@playwright/test";
import { acceptSignupTerms, login, USERS } from "./helpers";

test("organizador cria uma segunda organização e alterna entre elas", async ({ page }) => {
  const stamp = Date.now();
  const first = `Primeira Org ${stamp}`;
  const second = `Segunda Org ${stamp}`;

  await page.goto("/registrar?next=/organizador/cadastro");
  await page.getByLabel("Nome completo").fill("Organizadora E2E");
  await page.getByLabel("E-mail", { exact: true }).fill(`org-e2e+${stamp}@test.local`);
  await page.getByLabel("Senha", { exact: true }).fill("Cadastro#E2e2468");
  await page.getByLabel("Confirmar senha", { exact: true }).fill("Cadastro#E2e2468");
  await acceptSignupTerms(page);
  await page.getByRole("button", { name: "Criar conta" }).click();
  await page.waitForURL(/\/organizador\/cadastro/);

  const fill = async (name: string) => {
    await page.getByLabel("Nome público").fill(name);
    await page.getByLabel("Razão social").fill(`${name} LTDA`);
    await page.getByLabel("CNPJ", { exact: true }).fill("11.222.333/0001-81");
    await page.getByRole("button", { name: "Enviar para análise" }).click();
    await page.waitForURL(/\/organizador$/);
  };
  await fill(first);
  await expect(page.getByRole("heading", { level: 1 })).toHaveText(first);

  await page.goto("/organizador/organizacoes");
  await page.getByRole("link", { name: "Nova organização" }).click();
  await page.waitForURL(/\/organizacoes\/nova/);
  await fill(second);
  await expect(page.getByRole("heading", { level: 1 })).toHaveText(second);

  await page.goto("/organizador/organizacoes");
  await expect(page.locator("li").filter({ hasText: first })).toContainText("Responsável");
  await expect(page.locator("li").filter({ hasText: second })).toContainText("Ativa");
  await page.locator("li").filter({ hasText: first }).getByRole("button", { name: "Usar esta organização" }).click();
  await page.waitForURL(/\/organizador$/);
  await expect(page.getByRole("heading", { level: 1 })).toHaveText(first);
});

test("painel do organizador mostra pendências, próximos eventos e pedidos", async ({ page }) => {
  await login(page, USERS.producer, "/organizador");
  await expect(page.getByRole("heading", { name: "Próximos eventos" })).toBeVisible();
  await expect(page.getByRole("heading", { name: "Pedidos recentes" })).toBeVisible();
  await expect(page.getByRole("navigation", { name: "Ações rápidas" }).getByRole("link", { name: "Criar evento" })).toBeVisible();
  await expect(page.getByRole("progressbar").first()).toBeVisible();
});
