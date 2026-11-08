import { test, expect } from "@playwright/test";
import { login, USERS } from "./helpers";

// T6: admin só de suporte (seed) vê e usa apenas a parte dele do painel.
test("admin de suporte: menu restrito, área de outro papel recusada", async ({ page }) => {
  await login(page, "suporte@demo.eventobrasil.test", "/admin");
  await page.waitForURL(/\/admin$/);
  await expect(page.getByTestId("admin-roles")).toContainText("Suporte");
  const nav = page.getByRole("navigation").filter({ has: page.getByRole("link", { name: "Visão geral" }) });
  await expect(nav.getByRole("link", { name: "Clientes" })).toBeVisible();
  await expect(nav.getByRole("link", { name: "Transferências" })).toBeVisible();
  await expect(nav.getByRole("link", { name: "Cancelamentos" })).toBeVisible();
  await expect(nav.getByRole("link", { name: "Comissões" })).toHaveCount(0);
  await expect(nav.getByRole("link", { name: "Auditoria" })).toHaveCount(0);

  // Endereço digitado à mão: a página recusa e volta para a visão geral com aviso.
  await page.goto("/admin/configuracoes");
  await page.waitForURL(/\/admin\?semPermissao=1/);
  await expect(page.getByRole("alert").filter({ hasText: "Seu papel de administrador não dá acesso" })).toBeVisible();

  await page.goto("/admin/usuarios");
  await expect(page.getByRole("heading", { name: "Clientes" })).toBeVisible();
  // Suporte não gerencia papéis de outros admins.
  await expect(page.getByRole("button", { name: "Papéis" })).toHaveCount(0);
});

test("super admin vê o menu completo e o editor de papéis", async ({ page }) => {
  await login(page, USERS.admin, "/admin/usuarios");
  await page.waitForURL(/\/admin\/usuarios/);
  const nav = page.getByRole("navigation").filter({ has: page.getByRole("link", { name: "Visão geral" }) });
  await expect(nav.getByRole("link", { name: "Comissões" })).toBeVisible();
  await expect(nav.getByRole("link", { name: "Auditoria" })).toBeVisible();
  const support = page.getByRole("listitem").filter({ hasText: "suporte@demo.eventobrasil.test" });
  await expect(support.getByText("Admin: Suporte")).toBeVisible();
  await support.getByRole("button", { name: "Papéis" }).click();
  await expect(support.getByRole("checkbox", { name: /Suporte/ })).toBeChecked();
  await expect(support.getByRole("checkbox", { name: /Financeiro/ })).not.toBeChecked();
});

test("menu do admin fica recolhido e abre com o mouse em cima", async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 800 });
  await login(page, USERS.admin, "/admin/usuarios");
  await page.waitForURL(/\/admin\/usuarios/);
  const opener = page.getByRole("button", { name: "Abrir menu: Administração" });
  const panel = page.locator("aside").filter({ has: opener }).locator("> div");
  const link = page.getByRole("navigation", { name: "Menu do painel" }).getByRole("link", { name: "Eventos externos" });
  // Fechado: a faixa estreita aparece e o conteúdo ocupa o resto da largura.
  await expect(opener).toBeVisible();
  await expect(panel).toHaveCSS("opacity", "0");
  const title = await page.getByRole("heading", { level: 1 }).boundingBox();
  expect(title!.x).toBeLessThan(200);
  // Mouse em cima: abre por cima da faixa e do conteúdo (por isso o mouse vai à posição,
  // não ao botão, que fica coberto pelo menu aberto) e o link funciona.
  const box = (await opener.boundingBox())!;
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  await expect(panel).toHaveCSS("opacity", "1");
  await link.click();
  await page.waitForURL(/\/admin\/eventos-externos/);
  // Mouse fora: fecha de novo.
  await page.mouse.move(900, 600);
  await expect(panel).toHaveCSS("opacity", "0");
});
