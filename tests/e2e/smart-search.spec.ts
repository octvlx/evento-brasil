import { expect, test, type Page } from "@playwright/test";

// Busca inteligente única (header, home e /eventos): sugestões agrupadas, frase com
// cidade, seleção sem navegar, busca só ao confirmar, Voltar e celular.

const headerSearch = (page: Page) => page.locator("header").getByRole("combobox", { name: "Buscar eventos" });
const homeSearch = (page: Page) => page.getByRole("combobox", { name: "Buscar eventos, artistas, cidades ou locais" });

test("home: destaques acima de uma busca compacta, carrossel funcionando", async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 900 });
  await page.goto("/");
  const featured = page.getByRole("region", { name: "Eventos em destaque" });
  const search = page.getByRole("region", { name: "Buscar eventos" });
  await expect(featured).toBeVisible();
  await expect(search).toBeVisible();
  const [f, s] = [await featured.boundingBox(), await search.boundingBox()];
  expect(f!.y).toBeLessThan(s!.y);
  // Busca compacta: campo + chips de categoria, sem o hero antigo.
  expect(s!.height).toBeLessThan(170);
  await featured.getByRole("button", { name: "Próximo evento" }).click();
  await expect(page.getByTestId("carousel-position")).toHaveText(/^2 \//);
  // Um campo só: nada de seletor de cidade separado.
  await expect(page.getByLabel("Selecionar cidade")).toHaveCount(0);
});

test("header: frase com cidade, seleção sem navegar e busca só ao confirmar", async ({ page }) => {
  await page.goto("/");
  const input = headerSearch(page);
  await input.fill("jazz em ri");
  const option = page.getByRole("option", { name: /jazz em Rio de Janeiro — RJ/ });
  await expect(option).toBeVisible();
  await expect(page.getByRole("group", { name: "Buscas sugeridas" })).toBeVisible();
  await option.click();
  // Escolher não navega: preenche, mantém o foco e espera a confirmação.
  await expect(input).toHaveValue("jazz em Rio de Janeiro — RJ");
  await expect(input).toBeFocused();
  await expect(page).toHaveURL(/\/$/);
  await page.locator("header").getByRole("button", { name: "Buscar", exact: true }).click();
  await expect(page).toHaveURL(/\/eventos\?q=jazz\+em\+Rio\+de\+Janeiro&cidade=rio-de-janeiro-rj$/);
  await expect(page.getByTestId("search-summary")).toContainText("Resultados para “jazz” em Rio de Janeiro — RJ");
  await expect(page.getByRole("link", { name: /Jazz no Mirante/ })).toBeVisible();
  await expect(page.getByRole("link", { name: /Festival Litoral Sonoro/ })).toHaveCount(0);
  // O termo fica no campo e a busca pode ser alterada dali.
  await expect(headerSearch(page)).toHaveValue("jazz em Rio de Janeiro");
});

test("teclado: setas destacam, Enter seleciona, Escape fecha, Enter busca", async ({ page }) => {
  await page.goto("/");
  const input = homeSearch(page);
  await input.fill("Salvador");
  const listbox = page.getByRole("listbox", { name: "Sugestões de busca" }).last();
  await expect(listbox.getByRole("option", { name: /Salvador — BA/ })).toBeVisible();
  // Escape fecha a lista sem perder o texto; a seta reabre e destaca.
  await input.press("Escape");
  await expect(listbox).toBeHidden();
  await expect(input).toHaveValue("Salvador");
  await input.press("ArrowDown");
  await expect(listbox).toBeVisible();
  await expect(listbox.getByRole("option").first()).toHaveAttribute("aria-selected", "true");
  await input.press("Enter");
  await expect(input).toHaveValue("Salvador — BA");
  await expect(listbox).toBeHidden();
  await expect(page).toHaveURL(/\/$/);
  await input.press("Enter");
  await expect(page).toHaveURL(/\/eventos\?q=Salvador\+%E2%80%94\+BA&cidade=salvador-ba$/);
  await expect(page.getByRole("link", { name: /Axé de Rua/ })).toBeVisible();
});

test("texto livre sem acentos, sem sugestão escolhida, e ausência de resultados", async ({ page }) => {
  await page.goto("/");
  await homeSearch(page).fill("samba em sao paulo");
  await homeSearch(page).press("Enter");
  await expect(page).toHaveURL(/\/eventos\?q=samba\+em\+sao\+paulo$/);
  await expect(page.getByTestId("search-summary")).toContainText("em São Paulo — SP");
  await expect(page.getByRole("link", { name: /Noite de Samba no Terraço/ })).toBeVisible();

  // URL compartilhável: abrir de novo dá o mesmo resultado.
  await page.goto("/eventos?q=festival%20litoral");
  await expect(page.getByRole("link", { name: /Festival Litoral Sonoro/ })).toBeVisible();
  await expect(headerSearch(page)).toHaveValue("festival litoral");

  await page.goto("/eventos?q=xyzqwk");
  await expect(page.getByText("Nenhum evento encontrado para “xyzqwk”.", { exact: false })).toBeVisible();
  await expect(page.getByText("0 eventos encontrados")).toBeVisible();
});

test("Voltar: volta à página anterior; acesso direto vai para a home; e o voltar do navegador", async ({ page }) => {
  // Acesso direto à página de resultados.
  await page.goto("/eventos?q=jazz");
  await page.getByRole("button", { name: "Voltar" }).click();
  await expect(page).toHaveURL(/\/$/);

  // Home → busca → Voltar.
  await homeSearch(page).fill("festival");
  await homeSearch(page).press("Enter");
  await expect(page).toHaveURL(/\/eventos\?q=festival$/);
  await page.getByRole("button", { name: "Voltar" }).click();
  await expect(page).toHaveURL(/\/$/);

  // Botão voltar do navegador também.
  await homeSearch(page).fill("jazz");
  await homeSearch(page).press("Enter");
  await expect(page).toHaveURL(/q=jazz/);
  await page.goBack();
  await expect(page).toHaveURL(/\/$/);
  await expect(page.getByRole("region", { name: "Eventos em destaque" })).toBeVisible();
});

test("busca do header nas páginas públicas, sem duplicar a lógica", async ({ page }) => {
  for (const path of ["/eventos", "/cidades/franca-sp", "/eventos/festival-litoral-sonoro-rio-de-janeiro"]) {
    await page.goto(path);
    await expect(headerSearch(page)).toBeVisible();
    await expect(page.locator("header").getByRole("link", { name: "QQPega — início" })).toHaveAttribute("href", "/");
  }
  await headerSearch(page).fill("stand-up em belo");
  await expect(page.getByRole("option", { name: /stand-up em Belo Horizonte — MG/ })).toBeVisible();
  await expect(page.locator("header").getByRole("link", { name: "Entrar" })).toBeVisible();
  await expect(page.locator("header").getByRole("link", { name: "Criar conta" })).toBeVisible();
});

test("celular: lupa abre a busca, Entrar e Criar conta continuam, sem rolagem horizontal", async ({ page }) => {
  await page.setViewportSize({ width: 375, height: 800 });
  await page.goto("/");
  await expect(headerSearch(page)).toBeHidden();
  await expect(page.locator("header").getByRole("link", { name: "Entrar" })).toBeVisible();
  await expect(page.locator("header").getByRole("link", { name: "Criar conta" })).toBeVisible();
  const overflow = () => page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
  expect(await overflow()).toBeLessThanOrEqual(0);
  // Folga para fontes de outros sistemas (o CI roda em Linux): cabe também em 360 px.
  await page.setViewportSize({ width: 360, height: 800 });
  expect(await overflow()).toBeLessThanOrEqual(0);
  await page.setViewportSize({ width: 375, height: 800 });

  await page.getByRole("button", { name: "Abrir busca" }).click();
  const input = page.locator("#busca-mobile").getByRole("combobox", { name: "Buscar eventos" });
  await expect(input).toBeFocused();
  await input.fill("jazz em ri");
  await page.getByRole("option", { name: /jazz em Rio de Janeiro — RJ/ }).click();
  await expect(page).toHaveURL(/\/$/);
  await input.press("Enter");
  await expect(page).toHaveURL(/\/eventos\?q=jazz/);
  await expect(page.locator("#busca-mobile")).toHaveCount(0);
  // Na página de resultados, no celular, o campo fica no corpo da página.
  await expect(homeSearch(page)).toHaveValue("jazz em Rio de Janeiro");
  await page.getByRole("button", { name: "Abrir busca" }).click();
  await page.getByRole("button", { name: "Fechar busca" }).click();
  await expect(page.locator("#busca-mobile")).toHaveCount(0);
});
