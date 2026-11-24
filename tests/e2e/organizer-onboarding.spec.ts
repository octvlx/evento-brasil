import { expect, test } from "@playwright/test";
import { continueApplication, expectApplicationStep, login, signUpForOrganizer, USERS } from "./helpers";

test("novo organizador (CNPJ) se cadastra em passos → admin aprova pela fila", async ({ browser }) => {
  const stamp = Date.now();
  const orgName = `Produtora E2E ${stamp}`;
  const email = `e2e+${stamp}@test.local`;

  const owner = await (await browser.newContext()).newPage();
  await signUpForOrganizer(owner, email);

  // Perfil: empresa é o padrão; o resto do fluxo se adapta.
  await expectApplicationStep(owner, "perfil");
  await expect(owner.getByRole("navigation", { name: "Passos do cadastro" }).locator("[aria-current=step]")).toContainText("Perfil");
  await continueApplication(owner);

  // Marca: erro de validação no passo, com foco no campo.
  await expectApplicationStep(owner, "marca");
  await continueApplication(owner);
  await expect(owner.getByText("Informe o nome público")).toBeVisible();
  await expect(owner.getByLabel("Nome público")).toBeFocused();
  await owner.getByLabel("Nome público").fill(orgName);
  await continueApplication(owner);

  // Dados legais: máscara e dígito verificador conferido na hora.
  await expectApplicationStep(owner, "legal");
  await owner.getByLabel("Razão social").fill(`${orgName} LTDA`);
  await owner.getByLabel("CNPJ", { exact: true }).fill("11111111111111");
  await expect(owner.getByLabel("CNPJ", { exact: true })).toHaveValue("11.111.111/1111-11");
  await expect(owner.getByText("CNPJ inválido. Confira os números.")).toBeVisible();
  await continueApplication(owner);
  await expectApplicationStep(owner, "legal");
  await expect(owner.getByText("CNPJ inválido")).toBeVisible();
  await owner.getByLabel("CNPJ", { exact: true }).fill("11.222.333/0001-81");
  await expect(owner.getByText("CNPJ válido")).toBeVisible();
  await continueApplication(owner);

  // Contato: e-mail da conta já preenchido; celular com máscara.
  await expectApplicationStep(owner, "contato");
  await expect(owner.getByLabel("E-mail de contato")).toHaveValue(email);
  await owner.getByLabel(/Celular/).fill("11912345678");
  await expect(owner.getByLabel(/Celular/)).toHaveValue("(11) 91234-5678");

  // Voltar não perde dados.
  await owner.getByRole("button", { name: "Voltar" }).click();
  await expectApplicationStep(owner, "legal");
  await expect(owner.getByLabel("Razão social")).toHaveValue(`${orgName} LTDA`);
  await expect(owner.getByLabel("CNPJ", { exact: true })).toHaveValue("11.222.333/0001-81");
  await owner.getByRole("button", { name: "Voltar" }).click();
  await expectApplicationStep(owner, "marca");
  await expect(owner.getByLabel("Nome público")).toHaveValue(orgName);
  await continueApplication(owner);
  await continueApplication(owner);
  await expectApplicationStep(owner, "contato");
  await expect(owner.getByLabel(/Celular/)).toHaveValue("(11) 91234-5678");
  await continueApplication(owner);

  // Revisão: "Editar" volta ao passo e "Voltar para a revisão" retorna.
  await expectApplicationStep(owner, "revisao");
  await expect(owner.getByText("CNPJ ••• 0181")).toBeVisible();
  await owner.getByRole("button", { name: "Editar Marca" }).click();
  await expectApplicationStep(owner, "marca");
  await owner.getByRole("button", { name: "Voltar para a revisão" }).click();
  await expectApplicationStep(owner, "revisao");

  // Sem aceitar os termos, não envia.
  await owner.getByRole("button", { name: "Enviar para análise" }).click();
  await expect(owner.getByText("Para enviar, aceite os termos para organizadores.")).toBeVisible();
  await owner.getByRole("checkbox", { name: /Li e aceito os termos para organizadores/ }).check();
  await owner.getByRole("button", { name: "Enviar para análise" }).click();

  // Enviado: explica a análise sem sugerir aprovação.
  await expect(owner.getByRole("heading", { name: "Cadastro enviado para análise" })).toBeFocused();
  await expect(owner.getByText("Ele ainda não está aprovado")).toBeVisible();
  await owner.getByRole("link", { name: "Ir para o painel" }).click();
  await owner.waitForURL(/\/organizador$/);
  await expect(owner.getByText("Cadastro: Em análise")).toBeVisible();

  const admin = await (await browser.newContext()).newPage();
  await login(admin, USERS.admin, "/admin/organizadores");
  const row = admin.locator("li").filter({ hasText: orgName });
  await expect(row).toContainText("Em análise");
  await expect(row).toContainText("CNPJ final 0181");
  await row.getByRole("button", { name: "Aprovar" }).click();
  await expect(admin.locator("li").filter({ hasText: orgName })).toContainText("Aprovada");

  await owner.reload();
  await expect(owner.getByText("Cadastro: Aprovada")).toBeVisible();
});

test("organizador (CPF) recusado reenvia a partir da área pedida pelo admin", async ({ browser }) => {
  const stamp = Date.now();
  const orgName = `Coletivo E2E ${stamp}`;
  // Motivo sem pista no texto: quem decide o passo do reenvio é a área escolhida.
  const reason = `Confira os dados enviados ${stamp}`;

  const owner = await (await browser.newContext()).newPage();
  await signUpForOrganizer(owner, `e2e-cpf+${stamp}@test.local`);

  await expectApplicationStep(owner, "perfil");
  await owner.getByText("Pessoa física (CPF)", { exact: true }).click();
  await continueApplication(owner);
  await owner.getByLabel("Nome público").fill(orgName);
  await continueApplication(owner);
  await expectApplicationStep(owner, "legal");
  await expect(owner.getByLabel("Nome completo")).toBeVisible();
  await owner.getByLabel("Nome completo").fill("Fulana de Tal");
  await owner.getByLabel("CPF", { exact: true }).fill("52998224725");
  await expect(owner.getByLabel("CPF", { exact: true })).toHaveValue("529.982.247-25");
  await continueApplication(owner);
  await expectApplicationStep(owner, "contato");

  // Rascunho local: recarregar mantém o resto, mas o CPF nunca é guardado.
  await owner.reload();
  await expect(owner.getByText("Recuperamos o que você preencheu neste navegador.")).toBeVisible();
  await expectApplicationStep(owner, "legal");
  await expect(owner.getByLabel("CPF", { exact: true })).toHaveValue("");
  await expect(owner.getByLabel("Nome completo")).toHaveValue("");
  const stored = await owner.evaluate(() => Object.keys(localStorage).map((k) => localStorage.getItem(k)).join("\n"));
  expect(stored).toContain(orgName);
  expect(stored).not.toContain("52998224725");
  expect(stored).not.toContain("529.982.247-25");
  await owner.getByRole("button", { name: "Voltar" }).click();
  await expect(owner.getByLabel("Nome público")).toHaveValue(orgName);
  await continueApplication(owner);
  await owner.getByLabel("Nome completo").fill("Fulana de Tal");
  await owner.getByLabel("CPF", { exact: true }).fill("529.982.247-25");
  await continueApplication(owner);
  await continueApplication(owner);
  await expectApplicationStep(owner, "revisao");
  await expect(owner.getByText("CPF ••• 4725")).toBeVisible();
  await owner.getByRole("checkbox", { name: /Li e aceito os termos para organizadores/ }).check();
  await owner.getByRole("button", { name: "Enviar para análise" }).click();
  await expect(owner.getByRole("heading", { name: "Cadastro enviado para análise" })).toBeVisible();

  const admin = await (await browser.newContext()).newPage();
  await login(admin, USERS.admin, "/admin/organizadores");
  const row = admin.locator("li").filter({ hasText: orgName });
  await expect(row).toContainText("CPF final 4725");
  await row.getByRole("button", { name: "Rejeitar" }).click();
  await row.getByLabel("Motivo (enviado ao organizador)").fill(reason);
  await expect(row.getByRole("button", { name: "Confirmar recusa" })).toBeDisabled();
  await row.getByLabel("O que precisa de ajuste?").selectOption("LEGAL");
  await row.getByRole("button", { name: "Confirmar recusa" }).click();
  const rejectedRow = admin.locator("li").filter({ hasText: orgName });
  await expect(rejectedRow).toContainText("Rejeitada");
  await expect(rejectedRow).toContainText(`Motivo (Dados legais): ${reason}`);

  // Reenvio: motivo sempre visível e o fluxo abre nos dados legais.
  await owner.goto("/organizador/cadastro");
  await expect(owner.getByRole("alert").filter({ hasText: reason })).toContainText("Ajuste pedido em Dados legais.");
  await expectApplicationStep(owner, "legal");
  await expect(owner.getByText("Por segurança, os dados legais não ficam salvos para edição")).toBeVisible();
  await continueApplication(owner);
  await expect(owner.getByText("Informe o CPF")).toBeVisible();
  await expect(owner.getByLabel("Nome completo")).toBeFocused();
  await owner.getByLabel("Nome completo").fill("Fulana de Tal Souza");
  await owner.getByLabel("CPF", { exact: true }).fill("529.982.247-25");
  await continueApplication(owner);
  await expectApplicationStep(owner, "contato");
  await expect(owner.getByRole("alert").filter({ hasText: reason })).toBeVisible();
  await continueApplication(owner);
  await expectApplicationStep(owner, "revisao");
  await expect(owner.getByRole("definition").filter({ hasText: orgName })).toBeVisible();
  await owner.getByRole("checkbox", { name: /Li e aceito os termos para organizadores/ }).check();
  await owner.getByRole("button", { name: "Enviar para análise" }).click();
  await expect(owner.getByRole("heading", { name: "Cadastro enviado para análise" })).toBeVisible();
  await expect(owner.getByText("Recebemos o novo envio")).toBeVisible();
  await owner.getByRole("link", { name: "Ir para o painel" }).click();
  await owner.waitForURL(/\/organizador$/);
  await expect(owner.getByText("Cadastro: Em análise")).toBeVisible();
});
