import { test, expect } from "@playwright/test";
import { login, USERS } from "./helpers";

// Menu da conta (topo): abre com o mouse em cima, recolhe ao sair; clique não o fecha.
test("menu da conta abre com o mouse em cima e recolhe ao sair", async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 800 });
  await login(page, USERS.admin, "/minha-conta");
  await page.waitForURL(/\/minha-conta/);
  const summary = page.locator("header summary").filter({ hasText: "Menu da conta" });
  const item = page.locator("header").getByRole("link", { name: "Meus pedidos" });
  await expect(item).toBeHidden();

  await summary.hover();
  await expect(item).toBeVisible();
  // Do botão até o item, passando pelo espaço entre eles: continua aberto.
  const box = (await item.boundingBox())!;
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2, { steps: 8 });
  await expect(item).toBeVisible();
  // Clique no botão com o mouse em cima não fecha.
  await summary.click();
  await expect(item).toBeVisible();

  await page.mouse.move(400, 600, { steps: 5 });
  await expect(item).toBeHidden();

  // Teclado: Enter no botão abre e fecha.
  await summary.focus();
  await page.keyboard.press("Enter");
  await expect(item).toBeVisible();
  await page.keyboard.press("Enter");
  await expect(item).toBeHidden();
});
