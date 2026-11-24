import { expect, test } from "@playwright/test";
import { login, signUpForOrganizer, submitOrganizerApplication, USERS } from "./helpers";

test("organizador cria uma segunda organização e alterna entre elas", async ({ page }) => {
  const stamp = Date.now();
  const first = `Primeira Org ${stamp}`;
  const second = `Segunda Org ${stamp}`;

  await signUpForOrganizer(page, `org-e2e+${stamp}@test.local`, "Organizadora E2E");

  const fill = (name: string) => submitOrganizerApplication(page, { name });
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
