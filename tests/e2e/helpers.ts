import "dotenv/config";
import { expect, type Page } from "@playwright/test";
import pg from "pg";

export const DEMO_PASSWORD = "Demo@2026!";
export const USERS = {
  customer: "cliente@demo.eventobrasil.test",
  producer: "produtora@demo.eventobrasil.test",
  admin: "admin@demo.eventobrasil.test",
};

export async function login(page: Page, email: string, next = "/") {
  await page.goto(`/entrar?next=${encodeURIComponent(next)}`);
  await page.getByLabel("E-mail", { exact: true }).fill(email);
  await page.getByLabel("Senha", { exact: true }).fill(DEMO_PASSWORD);
  await page.getByRole("button", { name: "Entrar", exact: true }).click();
  await page.waitForURL((url) => !url.pathname.startsWith("/entrar"));
}

/** Lê o conteúdo do QR direto do banco de desenvolvimento (equivale a ler o QR com a câmera). */
export async function qrPayloadFor(code: string) {
  const client = new pg.Client({ connectionString: process.env.DATABASE_URL });
  await client.connect();
  const { rows } = await client.query('SELECT code, "validationToken", "eventId" FROM "IssuedTicket" WHERE code = $1', [code]);
  await client.end();
  expect(rows[0], `ingresso ${code}`).toBeTruthy();
  return { payload: `EB1:${rows[0].code}:${rows[0].validationToken}`, eventId: rows[0].eventId as string };
}
