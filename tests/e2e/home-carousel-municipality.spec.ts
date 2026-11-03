import { expect, test, type Page } from "@playwright/test";
import pg from "pg";
import { login, USERS } from "./helpers";

// Carrossel de destaques da home e autocomplete de município (base local do IBGE)
// no assistente de evento.

const carousel = (page: Page) => page.getByRole("region", { name: "Eventos em destaque" });
const position = (page: Page) => page.getByTestId("carousel-position");

async function noHorizontalPageScroll(page: Page) {
  expect(await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth)).toBeLessThanOrEqual(0);
}

async function query<T>(sql: string, params: unknown[] = []): Promise<T[]> {
  const client = new pg.Client({ connectionString: process.env.DATABASE_URL });
  await client.connect();
  try {
    return (await client.query(sql, params)).rows as T[];
  } finally {
    await client.end();
  }
}

test.describe("carrossel de destaques", () => {
  test("botões, navegação contínua, teclado e cards por tela", async ({ page }) => {
    await page.setViewportSize({ width: 1440, height: 900 });
    await page.goto("/");
    const region = carousel(page);
    await expect(region).toBeVisible();
    const total = await region.locator("li[aria-roledescription='slide']").count();
    expect(total).toBeGreaterThan(4);
    // Desktop largo: 4 cards visíveis.
    const widths = await region.evaluate((el) => {
      const track = el.querySelector("[data-testid='carousel-track']") as HTMLElement;
      return { track: track.clientWidth, card: (track.firstElementChild as HTMLElement).offsetWidth };
    });
    expect(Math.round(widths.track / widths.card)).toBe(4);
    // Capa via next/image (fill; o seed usa SVG, que o next/image serve sem otimizar).
    await expect(region.locator("img").first()).toHaveAttribute("data-nimg", "fill");

    await region.getByRole("button", { name: "Pausar passagem automática" }).click();
    await expect(position(page)).toHaveText(`1 / ${total}`);
    await region.getByRole("button", { name: "Próximo evento" }).click();
    await expect(position(page)).toHaveText(`2 / ${total}`);
    await region.getByRole("button", { name: "Evento anterior" }).click();
    await expect(position(page)).toHaveText(`1 / ${total}`);
    // Do primeiro, "anterior" vai ao fim; do fim, "próximo" volta ao primeiro.
    await region.getByRole("button", { name: "Evento anterior" }).click();
    await expect.poll(() => region.locator("[data-testid='carousel-track']").evaluate((t) => Math.abs(t.scrollWidth - t.clientWidth - t.scrollLeft))).toBeLessThan(3);
    await region.getByRole("button", { name: "Próximo evento" }).click();
    await expect(position(page)).toHaveText(`1 / ${total}`);
    // Teclado: setas com o foco dentro do carrossel.
    await region.getByRole("button", { name: "Próximo evento" }).focus();
    await page.keyboard.press("ArrowRight");
    await expect(position(page)).toHaveText(`2 / ${total}`);
    await page.keyboard.press("ArrowLeft");
    await expect(position(page)).toHaveText(`1 / ${total}`);
    await noHorizontalPageScroll(page);
  });

  test("avança sozinho a cada 5 s e pausa com o mouse em cima", async ({ page }) => {
    await page.setViewportSize({ width: 1440, height: 900 });
    await page.clock.install();
    await page.goto("/");
    const region = carousel(page);
    await expect(region).toBeVisible();
    await page.mouse.move(5, 5);
    await expect(position(page)).toHaveText(/^1 \//);
    await page.clock.runFor(5200);
    await expect(position(page)).toHaveText(/^2 \//);
    await region.hover();
    await page.clock.runFor(11000);
    await expect(position(page)).toHaveText(/^2 \//);
  });

  test("com prefers-reduced-motion não há avanço automático", async ({ page }) => {
    await page.emulateMedia({ reducedMotion: "reduce" });
    await page.setViewportSize({ width: 1440, height: 900 });
    await page.clock.install();
    await page.goto("/");
    const region = carousel(page);
    await expect(region).toBeVisible();
    await page.mouse.move(5, 5);
    await expect(region.getByRole("button", { name: /passagem automática/ })).toHaveCount(0);
    await page.clock.runFor(16000);
    await expect(position(page)).toHaveText(/^1 \//);
    // Os botões continuam funcionando.
    await region.getByRole("button", { name: "Próximo evento" }).click();
    await expect(position(page)).toHaveText(/^2 \//);
  });

  for (const [name, width, perView] of [
    ["tablet", 820, 2],
    ["celular", 390, 1],
  ] as const)
    test(`${name}: ${perView} card(s) por tela, sem rolagem horizontal da página`, async ({ page }) => {
      await page.setViewportSize({ width, height: 900 });
      await page.goto("/");
      const region = carousel(page);
      await expect(region).toBeVisible();
      const ratio = await region.locator("[data-testid='carousel-track']").evaluate((t) => t.clientWidth / (t.firstElementChild as HTMLElement).offsetWidth);
      expect(Math.round(ratio)).toBe(perView);
      await noHorizontalPageScroll(page);
    });
});

test("autocomplete de município: busca por UF, teclado e cidade criada só ao salvar", async ({ page }) => {
  const requests: string[] = [];
  page.on("request", (r) => requests.push(r.url()));
  const before = await query<{ n: number }>(`SELECT count(*)::int AS n FROM "City" WHERE "ibgeCode" = '4302303'`);
  expect(before[0].n).toBe(0);

  await login(page, USERS.producer, "/organizador/eventos/novo");
  await page.getByLabel("Nome do evento").fill(`Serra Gaúcha E2E ${Date.now()}`);
  await page.getByLabel("Categoria").selectOption({ label: "Festivais" });
  await expect(page.getByRole("status").filter({ hasText: /Salvo às/ })).toBeVisible();
  await page.getByRole("button", { name: "Continuar", exact: true }).click();
  await expect(page.getByRole("heading", { name: "Data e localização" })).toBeVisible();

  const day = new Date(Date.now() + 40 * 86_400_000).toISOString().slice(0, 10);
  await page.getByLabel("Início: data").fill(day);
  await page.getByLabel("Início: horário").fill("20:00");
  await page.getByLabel("Término: data").fill(day);
  await page.getByLabel("Término: horário").fill("23:00");
  const newVenue = page.getByRole("radio", { name: "Cadastrar novo local" });
  if (await newVenue.count()) await newVenue.check();
  await page.getByLabel("Nome do local").fill("Pavilhão da Serra");
  await page.getByLabel("Rua / avenida").fill("Rua das Hortênsias");
  await page.getByLabel("Número").fill("100");

  const city = page.getByRole("combobox", { name: "Cidade", exact: true });
  await expect(city).toBeDisabled();
  await page.getByLabel("Estado (UF)").selectOption("RS");
  await expect(city).toBeEnabled();
  await city.fill("zzzz");
  await expect(page.getByText("Nenhum município encontrado em RS.")).toBeVisible();
  await city.fill("bom jesus");
  const listbox = page.getByRole("listbox", { name: "Municípios" });
  await expect(listbox.getByRole("option", { name: "Bom Jesus — RS" })).toBeVisible();
  await expect(listbox.getByRole("option")).not.toContainText(["Bom Jesus — PI"]);
  await page.keyboard.press("Escape");
  await expect(listbox).toBeHidden();
  await page.keyboard.press("ArrowDown");
  await expect(listbox).toBeVisible();
  await expect(city).toHaveAttribute("aria-activedescendant", /.+/);
  await page.keyboard.press("Enter");
  await expect(city).toHaveValue("Bom Jesus — RS");
  await expect(listbox).toBeHidden();

  // Pesquisar não cria cidade; só a lista da UF escolhida foi baixada, do próprio servidor.
  expect(requests.some((u) => u.includes("/api/municipios/RS"))).toBe(true);
  expect(requests.some((u) => /\/api\/municipios\/(?!RS)/.test(u))).toBe(false);
  expect(requests.some((u) => u.includes("ibge.gov.br"))).toBe(false);

  await page.getByRole("button", { name: "Continuar", exact: true }).click();
  await expect(page.getByRole("heading", { name: "Ingressos e preços" })).toBeVisible();
  const draftUrl = page.url().replace(/etapa=\d/, "etapa=2");
  const created = await query<{ name: string; state: string; slug: string }>(`SELECT name, state, slug FROM "City" WHERE "ibgeCode" = '4302303'`);
  expect(created).toEqual([{ name: "Bom Jesus", state: "RS", slug: "bom-jesus-rs" }]);

  // Rascunho: a cidade nova não aparece nas páginas públicas.
  await page.goto("/eventos");
  await expect(page.getByRole("combobox", { name: "Cidade", exact: true }).locator("option", { hasText: "Bom Jesus" })).toHaveCount(0);
  await page.goto("/cidades/bom-jesus-rs");
  await expect(page.getByRole("heading", { name: "Página não encontrada" })).toBeVisible();

  // Voltar ao rascunho reexibe a cidade escolhida.
  await page.goto(draftUrl);
  await expect(page.getByRole("combobox", { name: "Cidade", exact: true })).toHaveValue("Bom Jesus — RS");
});
