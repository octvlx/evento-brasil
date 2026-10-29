import { verifySignupPhone } from "./helpers";
import "dotenv/config";
import { readFile } from "node:fs/promises";
import { expect, test } from "@playwright/test";
import pg from "pg";

// Termos versionados (R10) e "Baixar meus dados" (R9). O seed grava BUYER/PRIVACY v1;
// num banco sem o seed de termos, cria as mesmas versões (publicadas no passado).
async function ensureTerms(client: pg.Client) {
  await client.query(
    `INSERT INTO "TermsVersion" (id, kind, version, "textHash", "documentPath", "publishedAt")
     SELECT 'e2e-terms-' || lower(k), k::"TermsKind", 'v1', encode(sha256(convert_to('evento-brasil:termos:' || k || ':v1:rascunho', 'UTF8')), 'hex'), p, now() - interval '30 days'
     FROM (VALUES ('BUYER', '/termos'), ('PRIVACY', '/privacidade')) AS t(k, p)
     WHERE NOT EXISTS (SELECT 1 FROM "TermsVersion" v WHERE v.kind = k::"TermsKind")`,
  );
}

test("cadastro exige termos e privacidade, grava o aceite e a conta baixa os próprios dados", async ({ page }) => {
  const client = new pg.Client({ connectionString: process.env.DATABASE_URL });
  await client.connect();
  try {
    await ensureTerms(client);
    const email = `termos-e2e+${Date.now()}@test.local`;

    await page.goto("/registrar");
    await page.getByLabel("Nome completo").fill("Pessoa Termos E2E");
    await page.getByLabel("E-mail", { exact: true }).fill(email);
    await page.getByLabel("Senha", { exact: true }).fill("senha-segura-e2e");
    const terms = page.getByRole("checkbox", { name: /termos de uso/ });
    const privacy = page.getByRole("checkbox", { name: /política de privacidade/ });
    // Links para os textos ao lado de cada aceite.
    await expect(page.getByRole("link", { name: "termos de uso", exact: true })).toHaveAttribute("href", "/termos");
    await expect(page.getByRole("link", { name: "política de privacidade", exact: true })).toHaveAttribute("href", "/privacidade");

    await terms.check();
    await page.getByRole("button", { name: "Enviar código por SMS" }).click();
    await expect(page.getByText("É preciso confirmar a leitura da política de privacidade")).toBeVisible();
    await expect(page).toHaveURL(/\/registrar/);

    await privacy.check();
    await verifySignupPhone(page);
    await page.getByRole("button", { name: "Criar conta" }).click();
    await page.waitForURL((url) => !url.pathname.startsWith("/registrar"));

    const { rows } = await client.query(
      `SELECT v.kind, a.context, a.ip IS NOT NULL AS "hasIp" FROM "TermsAcceptance" a
       JOIN "TermsVersion" v ON v.id = a."termsVersionId" JOIN "User" u ON u.id = a."userId"
       WHERE u.email = $1 ORDER BY v.kind`,
      [email],
    );
    expect(rows).toEqual([
      { kind: "BUYER", context: "SIGNUP", hasIp: true },
      { kind: "PRIVACY", context: "SIGNUP", hasIp: true },
    ]);

    await page.goto("/minha-conta");
    const downloadPromise = page.waitForEvent("download");
    await page.getByRole("link", { name: "Baixar meus dados" }).click();
    const download = await downloadPromise;
    expect(download.suggestedFilename()).toMatch(/^meus-dados-evento-brasil-\d{4}-\d{2}-\d{2}\.json$/);
    const data = JSON.parse(await readFile((await download.path())!, "utf8"));
    expect(data.profile.email).toBe(email);
    expect(data.termsAcceptances.map((a: { kind: string }) => a.kind).sort()).toEqual(["BUYER", "PRIVACY"]);
    expect(JSON.stringify(data)).not.toMatch(/passwordHash|validationToken|tokenHash/);
  } finally {
    await client.end();
  }
});
