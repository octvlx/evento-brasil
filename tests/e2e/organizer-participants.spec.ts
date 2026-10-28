import { expect, test } from "@playwright/test";
import { login, USERS } from "./helpers";

// Dados do seed: um ingresso da "Noite de Samba no Terraço" foi transferido do cliente para
// a amiga; um do "Axé de Rua" tem transferência pendente; um evento tem janela de alteração aberta.
test("participantes mostram o titular atual, o histórico e exportam CSV", async ({ page }) => {
  await login(page, USERS.producer, "/organizador/participantes");
  await page.getByLabel("Evento", { exact: true }).selectOption({ label: "Noite de Samba no Terraço" });
  await page.getByRole("button", { name: "Ver" }).click();
  await page.waitForURL(/evento=/);

  const moved = page.locator("tr").filter({ hasText: "amiga@demo.eventobrasil.test" });
  await expect(moved.getByText("Transferido", { exact: true })).toBeVisible();
  await moved.getByText(/Histórico de transferências \(1\)/).click();
  await expect(moved.getByText(/cliente@demo\.eventobrasil\.test.*→.*amiga@demo\.eventobrasil\.test.*Aceita/)).toBeVisible();

  const href = await page.getByRole("link", { name: "Exportar CSV" }).getAttribute("href");
  const csv = await page.request.get(href!);
  expect(csv.status()).toBe(200);
  const text = await csv.text();
  expect(text).toContain('"codigo","titular","email_titular","conta_titular","transferido"');
  expect(text).toMatch(/"amiga@demo\.eventobrasil\.test","[^"]+","sim"/);

  await page.getByLabel("Evento", { exact: true }).selectOption({ label: "Axé de Rua — Ensaio Aberto" });
  await page.getByRole("button", { name: "Ver" }).click();
  await expect(page.getByText("Transferência pendente").first()).toBeVisible();
});

test("painel avisa janela de alteração aberta e a página do evento conta os pedidos de reembolso", async ({ page }) => {
  await login(page, USERS.producer, "/organizador");
  const alert = page.getByRole("region", { name: "Pendências" }).getByRole("status").filter({ hasText: "janela de reembolso por alteração aberta" }).first();
  await expect(alert).toBeVisible();
  await alert.getByRole("link", { name: "Resolver" }).click();
  await page.waitForURL(/\/organizador\/eventos\/[^/]+\/editar/);
  const summary = page.getByRole("status").filter({ hasText: "Janelas de reembolso por alteração abertas" });
  await expect(summary).toContainText(/reembolso integral até/);
  await expect(summary).toContainText(/comprador|Nenhum comprador/);
});
