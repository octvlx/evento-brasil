import { test, expect } from "@playwright/test";
import { acceptSignupTerms, confirmEmail, emailLink } from "./helpers";
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
  await page.getByLabel("Confirmar e-mail", { exact: true }).fill(email);
  await page.getByLabel("Senha", { exact: true }).fill("Cadastro#E2e2468");
  await page.getByLabel("Confirmar senha", { exact: true }).fill("Cadastro#E2e2468");
  await acceptSignupTerms(page);
  await page.getByRole("button", { name: "Criar conta", exact: true }).click();
  await page.waitForURL(/\/confirmar-email/);
  await confirmEmail(page, email);
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
    .fill("Recuperada#E2e1357");
  await page.getByLabel("Confirmar nova senha", { exact: true }).fill("Recuperada#E2e1357");
  await page.getByRole("button", { name: "Redefinir minha senha" }).click();
  await expect(page.getByRole("status").first()).toContainText(
    "Senha redefinida com sucesso!",
  );
  await page.goto("/minha-conta");
  await page.waitForURL(/\/entrar/);
  await page.getByLabel("E-mail", { exact: true }).fill(email);
  await page.getByLabel("Senha", { exact: true }).fill("Recuperada#E2e1357");
  await page.getByRole("button", { name: "Entrar", exact: true }).click();
  await page.waitForURL(/\/minha-conta/);
  await page.goto(link);
  await page.getByLabel("Nova senha", { exact: true }).fill("Repeticao#E2e9753");
  await page.getByLabel("Confirmar nova senha", { exact: true }).fill("Repeticao#E2e9753");
  await page.getByRole("button", { name: "Redefinir minha senha" }).click();
  await expect(page.getByRole("alert").first()).toContainText(
    "já foi utilizado",
  );
});
