import "dotenv/config";
import { test, expect } from "@playwright/test";
import pg from "pg";
import { acceptSignupTerms, confirmEmail, login, totpFor, USERS } from "./helpers";

// Exclusão definitiva pelo superadmin: confirmação explícita, bloqueio explicado e acesso encerrado.
const PASSWORD = "ExcluirConta#E2e2468";

test.describe("exclusão definitiva pelo superadmin", () => {
  test.skip(process.env.E2E_ISOLATED !== "1", "Ativa 2FA no admin e cria conta nova: só no banco descartável do E2E isolado.");

  // O 2FA ativado aqui no admin de demonstração não pode vazar para os outros testes.
  test.afterAll(async () => {
    const client = new pg.Client({ connectionString: process.env.DATABASE_URL });
    await client.connect();
    await client.query(
      `UPDATE "User" SET "totpSecretEncrypted" = NULL, "totpEnabledAt" = NULL, "totpLastStep" = NULL, "totpPendingSecretEncrypted" = NULL, "totpPendingAt" = NULL WHERE email = $1`,
      [USERS.admin],
    );
    await client.query(`DELETE FROM "TotpRecoveryCode" WHERE "userId" = (SELECT id FROM "User" WHERE email = $1)`, [USERS.admin]);
    await client.end();
  });

  test("bloqueio explicado para quem tem ingressos; exclusão confirmada encerra o acesso", async ({ page, browser }) => {
    // Conta nova de cliente, sem pedidos.
    const email = `excluir+${Date.now()}@test.local`;
    await page.goto("/registrar");
    await page.getByLabel("Nome completo", { exact: true }).fill("Pessoa Para Excluir");
    await page.getByLabel("E-mail", { exact: true }).fill(email);
    await page.getByLabel("Confirmar e-mail", { exact: true }).fill(email);
    await page.getByLabel("Senha", { exact: true }).fill(PASSWORD);
    await page.getByLabel("Confirmar senha", { exact: true }).fill(PASSWORD);
    await acceptSignupTerms(page);
    await page.getByRole("button", { name: "Criar conta", exact: true }).click();
    await page.waitForURL(/\/confirmar-email/);
    await confirmEmail(page, email);
    // Sessão aberta da pessoa num outro navegador: precisa cair depois da exclusão.
    const victim = await browser.newContext();
    const victimPage = await victim.newPage();
    await victimPage.goto("/entrar?next=/minha-conta");
    await victimPage.getByLabel("E-mail", { exact: true }).fill(email);
    await victimPage.getByLabel("Senha", { exact: true }).fill(PASSWORD);
    await victimPage.getByRole("button", { name: "Entrar", exact: true }).click();
    await victimPage.waitForURL(/\/minha-conta$/);

    // Superadmin ativa o 2FA (exigido para excluir).
    await page.context().clearCookies();
    await login(page, USERS.admin, "/minha-conta/seguranca");
    await page.getByRole("button", { name: "Ativar verificação em duas etapas" }).click();
    const secret = (await page.getByTestId("totp-secret").textContent())!;
    await page.getByLabel("Código de 6 dígitos").fill(totpFor(secret));
    await page.getByRole("button", { name: "Confirmar e ativar" }).click();
    await page.getByRole("button", { name: "Já guardei os códigos" }).click();

    // Cliente de demonstração com ingressos para eventos futuros: impedimento explicado, nada muda.
    await page.goto(`/admin/usuarios?q=${encodeURIComponent(USERS.customer)}`);
    const demo = page.getByRole("listitem").filter({ hasText: USERS.customer });
    await demo.getByRole("button", { name: "Excluir conta definitivamente" }).click();
    const demoForm = demo.getByRole("group", { name: /Excluir definitivamente a conta de/ });
    await expect(demoForm.getByText("Não dá para desfazer.", { exact: false })).toBeVisible();
    await demoForm.getByLabel("E-mail da conta, para confirmar").fill(USERS.customer);
    await demoForm.getByLabel("Motivo da exclusão").fill("Teste de impedimento");
    await demoForm.getByLabel("Seu código do aplicativo autenticador").fill("000000");
    await demoForm.getByRole("button", { name: "Excluir definitivamente" }).click();
    await expect(demoForm.getByRole("alert")).toContainText("ingressos válidos para eventos que ainda não terminaram");
    await expect(demo.getByText("Conta excluída")).toHaveCount(0);

    // Conta nova: confirmação com o e-mail digitado, motivo e código.
    await page.goto(`/admin/usuarios?q=${encodeURIComponent(email)}`);
    const row = page.getByRole("listitem").filter({ hasText: email });
    await row.getByRole("button", { name: "Excluir conta definitivamente" }).click();
    const form = row.getByRole("group", { name: "Excluir definitivamente a conta de Pessoa Para Excluir" });
    await expect(form.getByText(`Excluir definitivamente a conta de Pessoa Para Excluir (${email})?`)).toBeVisible();
    const submit = form.getByRole("button", { name: "Excluir definitivamente" });
    await form.getByLabel("E-mail da conta, para confirmar").fill("outro@test.local");
    await form.getByLabel("Motivo da exclusão").fill("Pedido do titular pelo SAC");
    await form.getByLabel("Seu código do aplicativo autenticador").fill(totpFor(secret, 1));
    await expect(submit).toBeDisabled();
    await form.getByLabel("E-mail da conta, para confirmar").fill(email);
    await submit.click();

    // A linha agora é a conta anonimizada (o e-mail some da lista).
    await page.goto("/admin/usuarios?q=Conta%20exclu%C3%ADda");
    await expect(page.getByRole("listitem").filter({ hasText: email })).toHaveCount(0);
    await page.goto(`/admin/usuarios?q=${encodeURIComponent(email)}`);
    await expect(page.getByRole("listitem").filter({ hasText: email })).toHaveCount(0);

    // Acesso encerrado: a sessão aberta caiu e a senha não entra mais.
    await victimPage.goto("/minha-conta");
    await victimPage.waitForURL(/\/entrar/);
    await victimPage.getByLabel("E-mail", { exact: true }).fill(email);
    await victimPage.getByLabel("Senha", { exact: true }).fill(PASSWORD);
    await victimPage.getByRole("button", { name: "Entrar", exact: true }).click();
    await expect(victimPage.getByRole("alert")).toBeVisible();
    await expect(victimPage).toHaveURL(/\/entrar/);
    await victim.close();
  });
});
