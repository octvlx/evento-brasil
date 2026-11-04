import { expect, test } from "@playwright/test";
import pg from "pg";

const SLUG_TITLE = "Frevo & Maracatu na Praça";

/** Deixa a inteira só com o que a reserva legal da meia-entrada barra; devolve a restauração. */
async function sellFullUpToReserve() {
  const client = new pg.Client({ connectionString: process.env.DATABASE_URL });
  await client.connect();
  const { rows } = await client.query(
    `SELECT t.id, t."quantitySold", e.capacity FROM "TicketType" t JOIN "Event" e ON e.id = t."eventId"
     WHERE e.title = $1 AND t.kind = 'GENERAL'`,
    [SLUG_TITLE],
  );
  expect(rows[0], "inteira do evento semeado").toBeTruthy();
  const { id, quantitySold, capacity } = rows[0] as { id: string; quantitySold: number; capacity: number };
  // Capacidade 400, meia 160 (40%): sobram 240 para a inteira antes do prazo da reserva.
  await client.query(`UPDATE "TicketType" SET "quantitySold" = $2 WHERE id = $1`, [id, capacity - Math.floor((capacity * 4000) / 10_000)]);
  return async () => {
    await client.query(`UPDATE "TicketType" SET "quantitySold" = $2 WHERE id = $1`, [id, quantitySold]);
    await client.end();
  };
}

test("inteira barrada pela reserva da meia-entrada mostra o motivo e a meia segue à venda", async ({ page }) => {
  const restore = await sellFullUpToReserve();
  try {
    await page.goto("/eventos");
    await page.getByRole("link", { name: new RegExp(SLUG_TITLE) }).first().click();
    const full = page.locator("li").filter({ hasText: "Inteira" }).first();
    await expect(full.getByText(/Ingressos restantes reservados para meia-entrada até \d{2}\/\d{2}\/\d{4} às \d{2}:\d{2}/)).toBeVisible();
    await expect(full.getByRole("button", { name: "Aumentar" })).toHaveCount(0);
    await expect(page.getByText("Ingressos esgotados")).toHaveCount(0);
    await expect(page.getByRole("group", { name: "Quantidade de Meia-entrada" }).getByRole("button", { name: "Aumentar" })).toBeEnabled();
    await expect(page.getByTestId("half-price-info")).toContainText("40% dos ingressos");
  } finally {
    await restore();
  }
});
