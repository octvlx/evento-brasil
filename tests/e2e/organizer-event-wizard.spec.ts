import { crc32, deflateSync } from "node:zlib";
import { expect, test, type Page } from "@playwright/test";
import { login, USERS } from "./helpers";

/** PNG de cor sólida (a galeria exige pelo menos 600 px no lado menor). */
function solidPng(size: number) {
  const chunk = (type: string, data: Buffer) => {
    const body = Buffer.concat([Buffer.from(type, "ascii"), data]);
    const len = Buffer.alloc(4);
    len.writeUInt32BE(data.length);
    const crc = Buffer.alloc(4);
    crc.writeUInt32BE(crc32(body));
    return Buffer.concat([len, body, crc]);
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0);
  ihdr.writeUInt32BE(size, 4);
  ihdr.set([8, 2, 0, 0, 0], 8); // 8 bits, RGB
  const row = Buffer.concat([Buffer.from([0]), Buffer.alloc(size * 3, 0x80)]);
  const raw = Buffer.concat(Array.from({ length: size }, () => row));
  return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk("IHDR", ihdr), chunk("IDAT", deflateSync(raw)), chunk("IEND", Buffer.alloc(0))]);
}

// Assistente de criação de evento: validação por etapa, autosave, voltar sem
// perder dados, recarregar a página, falha de rede ao salvar e publicação.

const ymd = (d: Date) => d.toISOString().slice(0, 10);

async function waitSaved(page: Page) {
  await expect(page.getByRole("status").filter({ hasText: /Salvo às/ })).toBeVisible();
}

test("organizador cria um evento pelo assistente passo a passo", async ({ page }) => {
  const title = `Festival Guiado E2E ${Date.now()}`;
  const day = ymd(new Date(Date.now() + 30 * 86_400_000));
  await login(page, USERS.producer, "/organizador/eventos/novo");
  await expect(page.getByRole("heading", { name: "Informações básicas" })).toBeVisible();
  await expect(page.getByRole("progressbar", { name: "Progresso do cadastro" })).toHaveAttribute("aria-valuenow", "0");

  // Etapa 1: validação antes de avançar; o autosave cria o rascunho.
  const next = page.getByRole("button", { name: "Continuar", exact: true });
  await next.click();
  await expect(page.getByText("Informe o título").first()).toBeVisible();
  await expect(page.getByLabel("Nome do evento")).toBeFocused();
  await page.getByLabel("Nome do evento").fill(title);
  await page.getByLabel("Categoria").selectOption({ label: "Festivais" });
  await waitSaved(page);
  await expect(page).toHaveURL(/evento=[^&]+&etapa=1/);
  await next.click();

  // Etapa 2: foco no título da etapa; "Voltar" preserva a etapa 1.
  const h2 = page.getByRole("heading", { name: "Data e localização" });
  await expect(h2).toBeFocused();
  await page.getByRole("button", { name: "Voltar" }).click();
  await expect(page.getByLabel("Nome do evento")).toHaveValue(title);
  await next.click();
  await expect(h2).toBeVisible();

  await page.getByLabel("Início: data").fill(day);
  await page.getByLabel("Início: horário").fill("20:00");
  await page.getByLabel("Término: data").fill(day);
  await page.getByLabel("Término: horário").fill("19:00");
  await page.getByRole("radio", { name: /Online/ }).check();
  await page.getByLabel("Link de acesso").fill("https://exemplo.com/live");
  await next.click();
  await expect(page.getByText("O término deve ser depois do início").first()).toBeVisible();
  await page.getByLabel("Término: horário").fill("23:00");
  await next.click();

  // Etapa 3: recarregar mantém a etapa e os dados salvos.
  await expect(page.getByRole("heading", { name: "Ingressos e preços" })).toBeVisible();
  await page.reload();
  await expect(page.getByRole("heading", { name: "Ingressos e preços" })).toBeVisible();
  await expect(page.getByRole("progressbar", { name: "Progresso do cadastro" })).toHaveAttribute("aria-valuenow", "40");
  await page.getByLabel("Capacidade total").fill("150");
  await next.click();
  await expect(page.getByText("Cadastre ao menos um tipo de ingresso para continuar.").first()).toBeVisible();
  await page.getByRole("button", { name: "Adicionar tipo de ingresso" }).click();
  await page.getByLabel("Nome", { exact: true }).fill("Inteira");
  await page.getByLabel("Preço (R$)").fill("60,00");
  await page.getByLabel("Quantidade").fill("150");
  await page.getByRole("button", { name: "Salvar ingresso" }).click();
  await expect(page.getByText(/você recebe ≈/).first()).toBeVisible();
  await page.getByRole("button", { name: "Duplicar Inteira" }).click();
  await expect(page.getByLabel("Nome", { exact: true })).toHaveValue("Inteira (cópia)");
  await page.getByRole("button", { name: "Cancelar" }).click();
  await expect(page.getByLabel("Capacidade total")).toHaveValue("150");
  await next.click();

  // Etapa 4: falha de rede no autosave é mostrada e recuperada.
  await expect(page.getByRole("heading", { name: "Imagens e descrição" })).toBeVisible();
  await page.route("**/organizador/eventos/novo**", (route) => (route.request().method() === "POST" ? route.abort() : route.continue()));
  await page.getByLabel("Descrição completa").fill("Uma noite de música com atrações nacionais e convidados.");
  await expect(page.getByText(/Erro ao salvar/)).toBeVisible();
  await page.unroute("**/organizador/eventos/novo**");
  await page.getByRole("button", { name: "Tentar novamente" }).click();
  await waitSaved(page);
  // Galeria no assistente: a foto é salva na hora, com a descrição informada.
  const gallery = page.getByRole("region", { name: "Galeria de fotos (opcional)" });
  await gallery.getByLabel("Descrição da nova foto (opcional)").fill("Palco principal");
  await gallery.getByLabel("Foto", { exact: true }).setInputFiles({ name: "palco.png", mimeType: "image/png", buffer: solidPng(640) });
  await expect(gallery.getByTestId("gallery-image")).toHaveCount(1);
  await expect(gallery.getByTestId("gallery-image").getByRole("img")).toHaveAttribute("alt", "Palco principal");
  await next.click();

  // Etapa 5 → revisão.
  await expect(page.getByRole("heading", { name: "Configurações", exact: true })).toBeVisible();
  await page.getByRole("button", { name: "Continuar para a revisão" }).click();
  await expect(page.getByRole("heading", { name: "Revisão e publicação" })).toBeVisible();
  await expect(page.getByRole("progressbar", { name: "Progresso do cadastro" })).toHaveAttribute("aria-valuenow", "100");
  await expect(page.getByText(title).first()).toBeVisible();
  await expect(page.getByText("1 foto", { exact: true })).toBeVisible();

  // "Editar" leva direto à etapa; o indicador volta para a revisão.
  await page.getByRole("button", { name: "Editar ingressos e preços" }).click();
  await expect(page.getByRole("heading", { name: "Ingressos e preços" })).toBeVisible();
  await page.getByRole("button", { name: /6\. Revisão e publicação/ }).click();
  await expect(page.getByRole("heading", { name: "Revisão e publicação" })).toBeVisible();

  await page.getByRole("button", { name: "Pré-visualizar" }).click();
  await expect(page.getByRole("region", { name: "Pré-visualização da página do evento" })).toContainText(title);

  await page.getByRole("button", { name: /Publicar evento|Enviar para publicação/ }).click();
  await page.waitForURL(/\/organizador\/eventos\/[^/]+\/editar$/);
  await expect(page.getByRole("heading", { name: title })).toBeVisible();
});

test("rascunho incompleto aparece na lista com 'Continuar cadastro'", async ({ page }) => {
  const title = `Rascunho E2E ${Date.now()}`;
  await login(page, USERS.producer, "/organizador/eventos/novo");
  await page.getByLabel("Nome do evento").fill(title);
  await page.getByLabel("Categoria").selectOption({ label: "Festivais" });
  await page.getByRole("button", { name: "Continuar", exact: true }).click();
  await expect(page.getByRole("heading", { name: "Data e localização" })).toBeVisible();

  await page.goto("/organizador/eventos");
  const row = page.getByRole("row").filter({ hasText: title });
  await expect(row).toContainText("A definir");
  await row.getByRole("link", { name: /Continuar cadastro/ }).click();
  await expect(page).toHaveURL(/etapa=2/);
  await expect(page.getByRole("heading", { name: "Data e localização" })).toBeVisible();

  // A página de gestão também leva de volta ao assistente enquanto houver etapa pendente.
  const id = new URL(page.url()).searchParams.get("evento");
  await page.goto(`/organizador/eventos/${id}/editar`);
  await expect(page).toHaveURL(/eventos\/novo\?evento=.+&etapa=2/);
});

test("evento publicado com vendas: edição pelo assistente sem autosave e com aviso de motivo", async ({ page }) => {
  await login(page, USERS.producer, "/organizador/eventos");
  await page.getByRole("row", { name: /Festival Litoral Sonoro/ }).getByRole("link", { name: "Gerenciar" }).click();
  await page.getByRole("link", { name: "Editar pelo assistente" }).click();
  await expect(page).toHaveURL(/\/assistente$/);
  await expect(page.getByText("Este evento já tem ingressos vendidos.")).toBeVisible();
  await expect(page.getByRole("heading", { name: "Informações básicas" })).toBeVisible();

  // Etapa 2 mostra o motivo (exigido para mudar data/local com vendas).
  await page.getByRole("button", { name: "Continuar", exact: true }).click();
  await expect(page.getByLabel(/Motivo da alteração/)).toBeVisible();
  await page.getByRole("button", { name: "Continuar", exact: true }).click();
  await page.getByRole("button", { name: "Continuar", exact: true }).click();

  // Etapa 4: a mudança só é gravada ao tocar em "Salvar alterações".
  await expect(page.getByRole("heading", { name: "Imagens e descrição" })).toBeVisible();
  const info = `Rampa e banheiro acessível (${Date.now()})`;
  await page.getByLabel("Acessibilidade (opcional)").fill(info);
  await page.waitForTimeout(2000);
  await expect(page.getByRole("status").filter({ hasText: /Salvo às/ })).toHaveCount(0);
  await page.getByRole("button", { name: "Salvar alterações" }).click();
  await waitSaved(page);
  await page.reload();
  await expect(page.getByLabel("Acessibilidade (opcional)")).toHaveValue(info);

  // Revisão em modo edição: sem publicar, com volta para a gestão.
  await page.getByRole("button", { name: /6\. Revisão/ }).click();
  await expect(page.getByRole("button", { name: /Publicar evento|Enviar para publicação/ })).toHaveCount(0);
  await page.getByRole("link", { name: "Voltar para a gestão" }).click();
  await expect(page).toHaveURL(/\/editar$/);
});
