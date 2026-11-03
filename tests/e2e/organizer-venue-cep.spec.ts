import { expect, test, type Page } from "@playwright/test";
import { login, USERS } from "./helpers";

// Busca de CEP no endereço do novo local (assistente de evento): ViaCEP só pelo
// servidor (respostas simuladas em tests/support/checkout-fetch-mock.mjs).

async function openStep2(page: Page) {
  await login(page, USERS.producer, "/organizador/eventos/novo");
  await page.getByLabel("Nome do evento").fill(`CEP E2E ${Date.now()}`);
  await page.getByLabel("Categoria").selectOption({ label: "Festivais" });
  await expect(page.getByRole("status").filter({ hasText: /Salvo às/ })).toBeVisible();
  await page.getByRole("button", { name: "Continuar", exact: true }).click();
  await expect(page.getByRole("heading", { name: "Data e localização" })).toBeVisible();
  const newVenue = page.getByRole("radio", { name: "Cadastrar novo local" });
  if (await newVenue.count()) await newVenue.check();
}

test("CEP preenche rua, bairro e cidade; erros deixam preencher à mão", async ({ page }) => {
  const requests: string[] = [];
  page.on("request", (r) => requests.push(r.url()));
  await openStep2(page);
  const cep = page.getByLabel("CEP");
  const street = page.getByLabel("Rua / avenida");
  const district = page.getByLabel("Bairro (opcional)");
  const city = page.getByRole("combobox", { name: "Cidade", exact: true });

  // CEP inexistente: mensagem e campos livres.
  await cep.fill("99999999");
  await page.getByRole("button", { name: "Buscar CEP" }).click();
  await expect(page.getByText(/CEP não encontrado.*Você pode preencher o endereço manualmente/)).toBeVisible();
  await expect(street).toHaveValue("");

  // Sair do campo busca sozinho e preenche o que está vazio.
  await cep.fill("01310930");
  await page.getByLabel("Número").focus();
  await expect(street).toHaveValue("Avenida Paulista");
  await expect(district).toHaveValue("Bela Vista");
  await expect(cep).toHaveValue("01310-930");
  await expect(page.getByLabel("Estado (UF)")).toHaveValue("SP");
  await expect(city).toHaveValue("São Paulo — SP");
  await expect(page.getByText(/Endereço localizado: Avenida Paulista, Bela Vista, São Paulo — SP/)).toBeVisible();

  // Ao sair do campo não sobrescreve o que o organizador digitou; o botão sobrescreve.
  await street.fill("Rua Digitada");
  await cep.fill("01001000");
  await page.getByLabel("Número").focus();
  await expect(city).toHaveValue("São Paulo — SP");
  await expect(street).toHaveValue("Rua Digitada");
  await page.getByRole("button", { name: "Buscar CEP" }).click();
  await expect(street).toHaveValue("Praça da Sé");
  await expect(district).toHaveValue("Sé");

  // CEP geral de cidade homônima: cidade pelo código IBGE, rua a informar.
  await cep.fill("95290-000");
  await page.getByRole("button", { name: "Buscar CEP" }).click();
  await expect(city).toHaveValue("Bom Jesus — RS");
  await expect(page.getByLabel("Estado (UF)")).toHaveValue("RS");
  await expect(page.getByText(/informe a rua \(CEP geral da cidade\)/)).toBeVisible();

  expect(requests.some((u) => u.includes("viacep.com.br"))).toBe(false);

  // Continua com os dados preenchidos e salva a etapa.
  await street.fill("Rua das Hortênsias");
  await page.getByLabel("Número").fill("100");
  await page.getByLabel("Nome do local").fill("Pavilhão do CEP");
  const day = new Date(Date.now() + 45 * 86_400_000).toISOString().slice(0, 10);
  await page.getByLabel("Início: data").fill(day);
  await page.getByLabel("Início: horário").fill("20:00");
  await page.getByLabel("Término: data").fill(day);
  await page.getByLabel("Término: horário").fill("23:00");
  await page.getByRole("button", { name: "Continuar", exact: true }).click();
  await expect(page.getByRole("heading", { name: "Ingressos e preços" })).toBeVisible();
});
