import { expect, test } from "@playwright/test";
import pg from "pg";
import { signUpForOrganizer, submitOrganizerApplication } from "./helpers";

// Organização suspensa pela plataforma: as páginas do painel não podem cair na tela
// genérica de erro. As que dependem de ações bloqueadas mostram o aviso da suspensão.
const PAGES = [
  "/organizador",
  "/organizador/eventos",
  "/organizador/eventos/novo",
  "/organizador/equipe",
  "/organizador/vendas",
  "/organizador/reembolsos",
  "/organizador/cupons",
  "/organizador/participantes",
  "/organizador/configuracoes",
  "/organizador/organizacoes",
];
const BLOCKED = ["/organizador/equipe", "/organizador/reembolsos", "/organizador/cupons"];

test("organização suspensa: painel sem erro genérico e com aviso nas áreas bloqueadas", async ({ page }) => {
  test.setTimeout(120_000);
  const stamp = Date.now();
  const name = `Suspensa E2E ${stamp}`;
  await signUpForOrganizer(page, `suspensa+${stamp}@test.local`);
  await submitOrganizerApplication(page, { name });

  const client = new pg.Client({ connectionString: process.env.DATABASE_URL });
  await client.connect();
  try {
    await client.query(`UPDATE "Organization" SET status = 'SUSPENDED', "statusReason" = $1 WHERE name = $2`, [`Documentação pendente ${stamp}`, name]);
  } finally {
    await client.end();
  }

  for (const path of PAGES) {
    await page.goto(path);
    await expect.soft(page.getByRole("heading", { level: 1 }), path).toBeVisible();
    await expect.soft(page.getByText("Algo deu errado"), path).toHaveCount(0);
    if (BLOCKED.includes(path)) {
      await expect.soft(page.getByText("Esta organização está suspensa", { exact: false }), path).toBeVisible();
      await expect.soft(page.getByText(`Documentação pendente ${stamp}`), path).toBeVisible();
    }
  }
});
