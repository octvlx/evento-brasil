import { test, expect } from "@playwright/test";
import { acceptSignupTerms } from "./helpers";

const FIRST = "Primeira#E2e2468";
const SECOND = "Segunda#E2e1357";

test("senha: requisitos no cadastro, troca em Minha conta com senha atual e login com a nova", async ({ page }) => {
  const email = `senha-e2e+${Date.now()}@test.local`;
  await page.goto("/registrar");
  await page.getByLabel("Nome completo", { exact: true }).fill("Pessoa Senha E2E");
  await page.getByLabel("E-mail", { exact: true }).fill(email);

  // Lista de requisitos atualiza enquanto digita; o botão de olho mostra a senha.
  const password = page.getByLabel("Senha", { exact: true });
  await password.fill("abc");
  const rules = page.getByRole("list", { name: "Requisitos da senha" });
  await expect(rules.getByText("Uma letra maiúscula")).toContainText("pendente");
  await password.fill(FIRST);
  await expect(rules.getByText("Uma letra maiúscula")).toContainText("atendido");
  await page.getByRole("button", { name: "Mostrar senha" }).first().click();
  await expect(password).toHaveAttribute("type", "text");

  // Confirmação diferente: o formulário não envia.
  await page.getByLabel("Confirmar senha", { exact: true }).fill("Outra#Coisa999");
  await acceptSignupTerms(page);
  await page.getByRole("button", { name: "Criar conta", exact: true }).click();
  await expect(page.getByText("As senhas não coincidem.")).toBeVisible();
  await page.getByLabel("Confirmar senha", { exact: true }).fill(FIRST);
  await page.getByRole("button", { name: "Criar conta", exact: true }).click();
  await page.waitForURL(/\/confirmar-email/);

  await page.goto("/minha-conta");
  const security = page.getByTestId("account-security");
  await expect(security.getByRole("heading", { name: "Segurança da conta" })).toBeVisible();
  await security.getByLabel("Senha atual", { exact: true }).fill("Errada#E2e0000");
  await security.getByLabel("Nova senha", { exact: true }).fill(SECOND);
  await security.getByLabel("Confirmar nova senha", { exact: true }).fill(SECOND);
  await security.getByRole("button", { name: "Alterar senha" }).click();
  await expect(security.getByText("A senha atual está incorreta.")).toBeVisible();

  await security.getByLabel("Senha atual", { exact: true }).fill(FIRST);
  await security.getByLabel("Nova senha", { exact: true }).fill(SECOND);
  await security.getByLabel("Confirmar nova senha", { exact: true }).fill(SECOND);
  await security.getByRole("button", { name: "Alterar senha" }).click();
  await expect(security.getByText("Sua senha foi alterada com sucesso.")).toBeVisible();
  await expect(security.getByLabel("Senha atual", { exact: true })).toHaveValue("");

  // A sessão atual continua; depois de sair, só a nova senha entra.
  await page.reload();
  await expect(page).toHaveURL(/\/minha-conta/);
  await page.getByRole("button", { name: "Sair da conta" }).click();
  await page.goto("/entrar");
  await page.getByLabel("E-mail", { exact: true }).fill(email);
  await page.getByLabel("Senha", { exact: true }).fill(FIRST);
  await page.getByRole("button", { name: "Entrar", exact: true }).click();
  await expect(page.getByText("E-mail ou senha incorretos.")).toBeVisible();
  // O formulário de login é reiniciado após a tentativa: preenche de novo.
  await page.getByLabel("E-mail", { exact: true }).fill(email);
  await page.getByLabel("Senha", { exact: true }).fill(SECOND);
  await page.getByRole("button", { name: "Entrar", exact: true }).click();
  await expect(page).not.toHaveURL(/\/entrar/);
});
