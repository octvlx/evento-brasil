import "dotenv/config";
import { test, expect } from "@playwright/test";
import pg from "pg";
import { login, USERS } from "./helpers";

// Evento externo publicado (inserido direto no banco descartável, como faria a importação
// revisada): página própria com "Evento externo", fonte e saída para o site oficial;
// aparece na busca e na cidade, separado dos eventos vendidos aqui.
const SLUG = `baile-de-teste-externo-duoticket-e2e${Date.now().toString(36)}`;
const TITLE = "Baile de Teste Externo";

test.describe("eventos externos", () => {
  test.skip(process.env.E2E_ISOLATED !== "1", "Insere evento externo: só no banco descartável do E2E isolado.");

  test.beforeAll(async () => {
    const client = new pg.Client({ connectionString: process.env.DATABASE_URL });
    await client.connect();
    const { rows } = await client.query(`SELECT id FROM "City" WHERE slug = 'sao-paulo-sp'`);
    const starts = new Date(Date.now() + 10 * 86_400_000);
    starts.setUTCHours(3, 0, 0, 0);
    await client.query(
      `INSERT INTO "ExternalEvent" (id, "sourceId", "sourceEventId", "sourceUrl", slug, title, "startsAt", "hasTime", timezone, "venueName", "cityName", state, "cityId", review, "isFeatured", "contentHash", "publishedAt", "updatedAt")
       VALUES ($1, 'extsrc_duoticket', $2, $3, $4, $5, $6, false, 'America/Sao_Paulo', 'Salão de Testes', 'São Paulo', 'SP', $7, 'PUBLISHED', true, 'e2e', now(), now())`,
      [`ext_${SLUG}`.slice(0, 30), SLUG.slice(-12), `https://duoticket.com.br/evento/999999/${SLUG}`, SLUG, TITLE, starts, rows[0]?.id ?? null],
    );
    await client.end();
  });

  test("página do evento externo, busca e cidade mostram a fonte e levam ao site oficial", async ({ page }) => {
    await page.goto(`/eventos-externos/${SLUG}`);
    await expect(page.getByRole("heading", { level: 1, name: TITLE })).toBeVisible();
    await expect(page.getByText("Evento externo", { exact: true }).first()).toBeVisible();
    await expect(page.getByText("Ingressos na Duoticket").first()).toBeVisible();
    await expect(page.getByText("Horário não informado pela fonte.")).toBeVisible();
    await expect(page.getByText("Preço não informado aqui: confira no site oficial.")).toBeVisible();
    await expect(page.getByText(/não organiza este evento, não vende os ingressos/)).toBeVisible();
    const cta = page.getByRole("link", { name: /Ver ingressos no site oficial/ });
    await expect(cta).toHaveAttribute("href", `/eventos-externos/${SLUG}/ir`);
    await expect(cta).toHaveAttribute("target", "_blank");
    // Sem checkout interno: nada de "Continuar para revisão" nem seletor de ingressos.
    await expect(page.getByRole("button", { name: "Continuar para revisão" })).toHaveCount(0);

    // A saída redireciona para a URL original (sem seguir para o site de terceiros).
    const res = await page.request.get(`/eventos-externos/${SLUG}/ir`, { maxRedirects: 0 });
    expect(res.status()).toBe(303);
    expect(res.headers()["location"]).toBe(`https://duoticket.com.br/evento/999999/${SLUG}`);

    await page.goto(`/eventos?q=${encodeURIComponent("Baile de Teste")}`);
    const section = page.getByRole("region", { name: /ingressos em outros sites/ });
    await expect(section.getByRole("link", { name: new RegExp(TITLE) })).toHaveAttribute("href", `/eventos-externos/${SLUG}`);

    // Destaque externo na home: junto dos nativos, leva ao link externo (pela saída /ir).
    await page.goto("/");
    await expect(page.getByRole("link", { name: new RegExp(`${TITLE} — evento externo`) }).first()).toHaveAttribute("href", `/eventos-externos/${SLUG}/ir`);

    await page.goto("/cidades/sao-paulo-sp");
    await expect(page.getByRole("region", { name: /Também em São Paulo/ }).getByText(TITLE)).toBeVisible();
  });

  test("admin vê as fontes com a situação de cada uma", async ({ page }) => {
    await login(page, USERS.admin, "/admin/eventos-externos");
    await page.waitForURL(/\/admin\/eventos-externos/);
    await expect(page.getByRole("heading", { level: 1, name: "Eventos externos" })).toBeVisible();
    const sympla = page.getByRole("listitem").filter({ hasText: "sympla.com.br" });
    await expect(sympla.getByText("Precisa de autorização")).toBeVisible();
    await expect(sympla.getByRole("button", { name: "Ativar" })).toHaveCount(0);
    await expect(page.getByRole("listitem").filter({ hasText: "duoticket.com.br" }).getByRole("button", { name: "Ativar" })).toBeVisible();
  });
});

test.describe("publicação em lote no admin", () => {
  test.skip(process.env.E2E_ISOLATED !== "1", "Insere eventos externos: só no banco descartável do E2E isolado.");
  const tag = Date.now().toString(36);
  const names = [`Lote ${tag} Alfa`, `Lote ${tag} Beta`, `Outro ${tag} Gama`];

  test.beforeAll(async () => {
    const client = new pg.Client({ connectionString: process.env.DATABASE_URL });
    await client.connect();
    const starts = new Date(Date.now() + 12 * 86_400_000);
    for (const [i, title] of names.entries()) {
      const slug = `lote-${tag}-${i}`;
      // Com capa já definida: a publicação não precisa buscar nada na internet.
      await client.query(
        `INSERT INTO "ExternalEvent" (id, "sourceId", "sourceEventId", "sourceUrl", slug, title, "startsAt", "hasTime", timezone, "cityName", state, review, "contentHash", "coverImageUrl", "updatedAt")
         VALUES ($1, 'extsrc_duoticket', $2, $3, $4, $5, $6, false, 'America/Sao_Paulo', 'Campinas', 'SP', 'PENDING_REVIEW', 'e2e', '/placeholder/lote.svg', now())`,
        [`lote_${tag}_${i}`, `l${tag}${i}`, `https://duoticket.com.br/evento/99${i}/${slug}`, slug, title, starts],
      );
    }
    await client.end();
  });

  test("filtra, seleciona todos os filtrados, confirma com os nomes e publica só eles", async ({ page }) => {
    await login(page, USERS.admin, "/admin/eventos-externos");
    await page.waitForURL(/\/admin\/eventos-externos/);
    const publish = page.getByRole("button", { name: "Publicar selecionados" });
    await expect(publish).toBeDisabled();

    await page.getByLabel("Nome").fill(`Lote ${tag}`);
    await page.getByRole("button", { name: "Filtrar" }).click();
    await page.waitForURL(new RegExp(`q=Lote`));
    await expect(page.getByText("2 eventos com esses filtros.")).toBeVisible();

    await page.getByLabel(/Selecionar todos os eventos desta página \(2\)/).check();
    await expect(page.getByText("2 eventos selecionados")).toBeVisible();
    await publish.click();
    const dialog = page.getByRole("dialog", { name: "Publicar 2 eventos?" });
    await expect(dialog.getByRole("listitem")).toHaveText([names[0], names[1]]);
    await dialog.getByRole("button", { name: "Publicar 2" }).click();

    await expect(page.getByRole("status").filter({ hasText: "2 eventos publicados" })).toBeVisible();
    // A lista foi atualizada: os publicados saíram de "Em revisão".
    await expect(page.getByText("0 eventos com esses filtros.")).toBeVisible();

    // O evento fora do filtro continua em revisão; os dois estão em Publicados.
    await page.goto(`/admin/eventos-externos?aba=PENDING_REVIEW&q=${encodeURIComponent(`Outro ${tag}`)}`);
    await expect(page.getByText(names[2])).toBeVisible();
    await page.goto(`/admin/eventos-externos?aba=PUBLISHED&q=${encodeURIComponent(`Lote ${tag}`)}`);
    await expect(page.getByText("2 eventos com esses filtros.")).toBeVisible();
  });
});

test.describe("destaque em lote no admin", () => {
  test.skip(process.env.E2E_ISOLATED !== "1", "Insere eventos externos: só no banco descartável do E2E isolado.");
  const tag = `d${Date.now().toString(36)}`;
  const names = [`Vitrine ${tag} Um`, `Vitrine ${tag} Dois`, `Vitrine ${tag} Tres`];
  const day = new Date(Date.now() + 20 * 86_400_000);
  const iso = (d: Date) => d.toISOString().slice(0, 10);

  test.beforeAll(async () => {
    const client = new pg.Client({ connectionString: process.env.DATABASE_URL });
    await client.connect();
    for (const [i, title] of names.entries()) {
      const slug = `vitrine-${tag}-${i}`;
      await client.query(
        `INSERT INTO "ExternalEvent" (id, "sourceId", "sourceEventId", "sourceUrl", slug, title, "startsAt", "hasTime", timezone, "cityName", state, review, "isFeatured", "contentHash", "coverImageUrl", "publishedAt", "updatedAt")
         VALUES ($1, 'extsrc_duoticket', $2, $3, $4, $5, $6, false, 'America/Sao_Paulo', 'Campinas', 'SP', 'PUBLISHED', $7, 'e2e', '/placeholder/vitrine.svg', now(), now())`,
        [`vit_${tag}_${i}`, `v${tag}${i}`, `https://duoticket.com.br/evento/98${i}/${slug}`, slug, title, day, i === 1],
      );
    }
    await client.end();
  });

  test("seleciona os publicados da página, destaca, mostra o resultado e limpa a seleção", async ({ page }) => {
    const qs = `aba=PUBLISHED&q=${encodeURIComponent(`Vitrine ${tag}`)}&de=${iso(new Date(day.getTime() - 86_400_000))}&ate=${iso(new Date(day.getTime() + 86_400_000))}`;
    await login(page, USERS.admin, `/admin/eventos-externos?${qs}`);
    await page.waitForURL(/aba=PUBLISHED/);
    // Filtros de situação e período preservados.
    await expect(page.locator("#filtro-de")).toHaveValue(iso(new Date(day.getTime() - 86_400_000)));
    const feature = page.getByRole("button", { name: "Destacar selecionados" });
    await expect(feature).toBeDisabled();

    await page.getByLabel(/Selecionar todos os eventos desta página \(3\)/).check();
    await expect(page.getByText("3 eventos selecionados")).toBeVisible();
    await feature.click();
    const dialog = page.getByRole("dialog", { name: "Destacar 3 eventos?" });
    await expect(dialog.getByRole("listitem")).toHaveText(names);
    await dialog.getByRole("button", { name: "Destacar 3" }).click();

    await expect(page.getByRole("status").filter({ hasText: "2 eventos destacados · 1 já estava em destaque" })).toBeVisible();
    await expect(page.getByText("0 eventos selecionados")).toBeVisible();
    await expect(feature).toBeDisabled();
    // Lista atualizada: os três com o selo de destaque e o botão individual invertido.
    for (const n of names) await expect(page.getByRole("listitem").filter({ hasText: n }).getByText("Destaque", { exact: true })).toBeVisible();
    await expect(page.getByRole("button", { name: "Remover destaque", exact: true })).toHaveCount(3);

    // Remover destaque em lote: seleciona dois e confirma.
    await page.getByRole("checkbox", { name: `Selecionar ${names[0]}` }).check();
    await page.getByRole("checkbox", { name: `Selecionar ${names[2]}` }).check();
    await page.getByRole("button", { name: "Remover destaque dos selecionados" }).click();
    const off = page.getByRole("dialog", { name: "Remover destaque de 2 eventos?" });
    await expect(off.getByRole("listitem")).toHaveText([names[0], names[2]]);
    await off.getByRole("button", { name: "Remover destaque de 2" }).click();
    await expect(page.getByRole("status").filter({ hasText: "2 eventos saíram do destaque" })).toBeVisible();
    await expect(page.getByRole("button", { name: "Remover destaque", exact: true })).toHaveCount(1);
    await expect(page.getByText("0 eventos selecionados")).toBeVisible();
  });
});
