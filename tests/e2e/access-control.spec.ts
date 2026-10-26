import { expect, test } from "@playwright/test";
import { login, USERS } from "./helpers";

test("áreas restritas exigem login e papel adequado", async ({ page }) => {
  await page.goto("/organizador");
  await expect(page).toHaveURL(/\/entrar\?next=%2Forganizador/);
  await page.goto("/meus-ingressos");
  await expect(page).toHaveURL(/\/entrar/);

  await login(page, USERS.customer);
  await page.goto("/admin");
  await expect(page).toHaveURL("http://localhost:3000/");
  // Cliente sem organização vai para o onboarding.
  await page.goto("/organizador");
  await expect(page).toHaveURL(/\/organizador\/cadastro/);
});

test("APIs protegidas recusam acesso indevido", async ({ request, page }) => {
  // Webhook sem assinatura válida
  const hook = await request.post("/api/webhooks/simulated", { data: { id: "x", type: "payment.updated", data: { id: "y" } } });
  expect(hook.status()).toBe(401);
  // Cron sem segredo
  expect((await request.post("/api/cron/maintenance")).status()).toBe(403);
  // PDF de ingresso sem login
  expect((await request.get("/api/tickets/ABCDEFGHJK/pdf")).status()).toBe(401);

  // Cliente não exporta participantes de evento alheio
  await login(page, USERS.customer);
  const anyEvent = await page.request.get("/eventos");
  expect(anyEvent.ok()).toBeTruthy();
  const csv = await page.request.get("/api/organizador/eventos/qualquer-id/participantes");
  expect(csv.status()).toBe(403);
});
