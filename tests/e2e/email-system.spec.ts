import { test, expect } from "@playwright/test";
import { readFile } from "node:fs/promises";
import path from "node:path";
import pg from "pg";
import { acceptSignupTerms } from "./helpers";
async function emailLink(email: string, template: string, route: string) {
  const client = new pg.Client({ connectionString: process.env.DATABASE_URL });
  await client.connect();
  try {
    let link = "";
    await expect
      .poll(async () => {
        const { rows } = await client.query(
          'SELECT "providerMessageId" FROM "EmailOutbox" WHERE recipient=$1 AND template=$2 AND status=\'SENT\' ORDER BY "createdAt" DESC LIMIT 1',
          [email, template],
        );
        if (!rows[0]?.providerMessageId) return false;
        const filename =
          rows[0].providerMessageId.replace(/^console:/, "") + ".html";
        const html = await readFile(
          path.resolve(".data/outbox", filename),
          "utf8",
        );
        const match = html.match(
          new RegExp('href="([^\"]*' + route + '[^\"]*)"'),
        );
        link = match?.[1]?.replace(/&amp;/g, "&") ?? "";
        return !!link;
      })
      .toBe(true);
    return link;
  } finally {
    await client.end();
  }
}
test("email recovery: console verification, reset, session revocation and safe login", async ({
  page,
}) => {
  test.skip(
    process.env.E2E_ISOLATED !== "1",
    "Only disposable database and console previews.",
  );
  const email = "email-system+" + Date.now() + "@test.local";
  await page.goto("/registrar");
  await page.getByLabel("Nome completo", { exact: true }).fill("Pessoa Email");
  await page.getByLabel("E-mail", { exact: true }).fill(email);
  await page.getByLabel("Senha", { exact: true }).fill("senha-original-123");
  await acceptSignupTerms(page);
  await page.getByRole("button", { name: "Criar conta", exact: true }).click();
  await page.waitForURL(/\/confirmar-email/);
  await page.goto(
    await emailLink(email, "EMAIL_VERIFICATION", "confirmar-email"),
  );
  await page
    .getByRole("button", { name: "Confirmar meu e-mail", exact: true })
    .click();
  await expect(
    page
      .getByRole("status")
      .filter({ hasText: "E-mail confirmado com sucesso." }),
  ).toBeVisible();
  await page.goto("/esqueci-minha-senha");
  await page.getByLabel("E-mail da sua conta").fill(email);
  await page
    .getByRole("button", { name: "Enviar link de recuperação" })
    .click();
  await page.waitForURL(/\/email-enviado/);
  const link = await emailLink(email, "PASSWORD_RESET", "redefinir-senha");
  await page.goto(link);
  await page
    .getByLabel("Nova senha", { exact: true })
    .fill("senha-nova-segura-123");
  await page.getByLabel("Confirme a nova senha").fill("senha-nova-segura-123");
  await page.getByRole("button", { name: "Redefinir minha senha" }).click();
  await expect(page.getByRole("status").first()).toContainText(
    "Sua senha foi redefinida",
  );
  await page.goto("/minha-conta");
  await page.waitForURL(/\/entrar/);
  await page.getByLabel("E-mail", { exact: true }).fill(email);
  await page.getByLabel("Senha", { exact: true }).fill("senha-nova-segura-123");
  await page.getByRole("button", { name: "Entrar", exact: true }).click();
  await page.waitForURL(/\/minha-conta/);
  await page.goto(link);
  await page.getByLabel("Nova senha", { exact: true }).fill("senha-replay-123");
  await page.getByLabel("Confirme a nova senha").fill("senha-replay-123");
  await page.getByRole("button", { name: "Redefinir minha senha" }).click();
  await expect(page.getByRole("alert").first()).toContainText(
    "já foi utilizado",
  );
});
