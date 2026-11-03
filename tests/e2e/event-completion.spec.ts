import { expect, test } from "@playwright/test";
import pg from "pg";

// Evento cujo término passou, com o status ainda PUBLISHED no banco (o cron não
// rodou): some das listagens, a página abre com "Evento encerrado" e sem compra.

async function query<T>(sql: string, params: unknown[] = []): Promise<T[]> {
  const client = new pg.Client({ connectionString: process.env.DATABASE_URL });
  await client.connect();
  try {
    return (await client.query(sql, params)).rows as T[];
  } finally {
    await client.end();
  }
}

test("término passado sem o cron: fora da home e da busca, página com Evento encerrado e sem venda", async ({ page }) => {
  const [event] = await query<{ id: string; slug: string; startsAt: Date; endsAt: Date }>(
    `SELECT id, slug, "startsAt", "endsAt" FROM "Event" WHERE title = 'Congresso Cerrado Digital' AND status = 'PUBLISHED'`,
  );
  expect(event).toBeTruthy();
  await query(`UPDATE "Event" SET "startsAt" = now() - interval '5 hours', "endsAt" = now() - interval '1 hour' WHERE id = $1`, [event.id]);
  try {
    expect((await query<{ status: string }>(`SELECT status FROM "Event" WHERE id = $1`, [event.id]))[0].status).toBe("PUBLISHED");

    await page.goto("/eventos?q=Congresso%20Cerrado");
    await expect(page.getByText("0 eventos encontrados")).toBeVisible();
    await page.goto("/eventos");
    await expect(page.getByRole("link", { name: /Congresso Cerrado Digital/ })).toHaveCount(0);
    await page.goto("/");
    await expect(page.getByRole("link", { name: /Congresso Cerrado Digital/ })).toHaveCount(0);

    await page.goto(`/eventos/${event.slug}`);
    await expect(page.getByRole("heading", { level: 1, name: "Congresso Cerrado Digital" })).toBeVisible();
    await expect(page.getByTestId("event-ended")).toHaveText("Evento encerrado");
    await expect(page.getByRole("status").filter({ hasText: "As vendas estão encerradas" })).toBeVisible();
    await expect(page.getByRole("button", { name: "Continuar para revisão" })).toHaveCount(0);
    await expect(page.getByRole("button", { name: "Aumentar" })).toHaveCount(0);
  } finally {
    await query(`UPDATE "Event" SET "startsAt" = $2, "endsAt" = $3 WHERE id = $1`, [event.id, event.startsAt, event.endsAt]);
  }
});
