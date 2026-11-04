import { test, expect } from "@playwright/test";
import { acceptSignupTerms, confirmEmail, totpFor } from "./helpers";

const PASSWORD = "DuasEtapas#E2e2468";

test("2FA: ativar com o aplicativo, entrar com o código e com um código de recuperação", async ({ page }) => {
  test.skip(process.env.E2E_ISOLATED !== "1", "Cria conta nova: só no banco descartável do E2E isolado.");
  const email = `dois-fatores+${Date.now()}@test.local`;
  await page.goto("/registrar");
  await page.getByLabel("Nome completo", { exact: true }).fill("Pessoa Duas Etapas");
  await page.getByLabel("E-mail", { exact: true }).fill(email);
  await page.getByLabel("Confirmar e-mail", { exact: true }).fill(email);
  await page.getByLabel("Senha", { exact: true }).fill(PASSWORD);
  await page.getByLabel("Confirmar senha", { exact: true }).fill(PASSWORD);
  await acceptSignupTerms(page);
  await page.getByRole("button", { name: "Criar conta", exact: true }).click();
  await page.waitForURL(/\/confirmar-email/);
  await confirmEmail(page, email);

  // Minha conta → Segurança → ativar.
  await page.goto("/minha-conta");
  await page.getByRole("link", { name: "Ativar verificação em duas etapas" }).click();
  await page.waitForURL(/\/minha-conta\/seguranca/);
  await page.getByRole("button", { name: "Ativar verificação em duas etapas" }).click();
  await expect(page.getByRole("img", { name: /QR code para configurar/ })).toBeVisible();
  const secret = (await page.getByTestId("totp-secret").textContent())!;
  await page.getByLabel("Código de 6 dígitos").fill("000000");
  await page.getByRole("button", { name: "Confirmar e ativar" }).click();
  await expect(page.getByText(/Código incorreto/)).toBeVisible();
  await page.getByLabel("Código de 6 dígitos").fill(totpFor(secret));
  await page.getByRole("button", { name: "Confirmar e ativar" }).click();
  const codes = page.getByRole("list", { name: "Códigos de recuperação" }).getByRole("listitem");
  await expect(codes).toHaveCount(10);
  const recovery = (await codes.first().textContent())!.trim();
  await page.getByRole("button", { name: "Já guardei os códigos" }).click();
  await expect(page.getByText(/Verificação em duas etapas ativa/)).toBeVisible();

  // Novo login: a senha sozinha não basta.
  const loginWithPassword = async () => {
    await page.context().clearCookies();
    await page.goto("/entrar?next=/minha-conta");
    await page.getByLabel("E-mail", { exact: true }).fill(email);
    await page.getByLabel("Senha", { exact: true }).fill(PASSWORD);
    await page.getByRole("button", { name: "Entrar", exact: true }).click();
    await page.waitForURL(/\/entrar\/verificacao/);
    // Sem o código, as páginas da conta continuam pedindo a verificação.
    await page.goto("/minha-conta");
    await page.waitForURL(/\/entrar\/verificacao/);
  };
  await loginWithPassword();
  await page.getByLabel("Código de 6 dígitos").fill("000000");
  await page.getByRole("button", { name: "Verificar e entrar" }).click();
  await expect(page.getByText(/Código incorreto/)).toBeVisible();
  // Próximo passo de 30 s: o da ativação já foi usado e não vale de novo.
  await page.getByLabel("Código de 6 dígitos").fill(totpFor(secret, 1));
  await page.getByRole("button", { name: "Verificar e entrar" }).click();
  await page.waitForURL(/\/minha-conta$/);
  await expect(page.getByRole("heading", { level: 1, name: "Minha conta" })).toBeVisible();

  // Celular perdido: código de recuperação, uma única vez.
  await loginWithPassword();
  await page.getByRole("button", { name: /usar um código de recuperação/ }).click();
  await page.getByLabel("Código de recuperação").fill(recovery);
  await page.getByRole("button", { name: "Verificar e entrar" }).click();
  await page.waitForURL(/\/minha-conta$/);
  await page.goto("/minha-conta/seguranca");
  await expect(page.getByText(/Códigos de recuperação restantes: 9/)).toBeVisible();
});
