import { proceedThroughReview } from "./helpers";
import { expect, test, type Page } from "@playwright/test";
import pg from "pg";
import { login, nextScan, openScanner, qrPayloadFor, USERS } from "./helpers";

const STAFF = "portaria@demo.eventobrasil.test";

test("compra com PIX simulado → ingresso com QR → check-in → leitura duplicada recusada", async ({ browser }) => {
  // Comprador
  const buyer = await (await browser.newContext()).newPage();
  await login(buyer, USERS.customer, "/eventos/festival-litoral-sonoro-rio-de-janeiro");
  await expect(buyer.getByRole("heading", { level: 1 })).toHaveText(/Festival Litoral Sonoro/);
  const lote = buyer.locator("li").filter({ hasText: "Lote promocional" });
  await lote.getByRole("button", { name: "Aumentar" }).click();
  await expect(buyer.getByText("Ingressos (1)")).toBeVisible();
  await buyer.getByRole("button", { name: "Continuar para revisão" }).click();

  await proceedThroughReview(buyer);
  await expect(buyer.getByText("Pagamento simulado.")).toBeVisible();
  await buyer.getByRole("button", { name: "Gerar PIX" }).click();
  await expect(buyer.getByText(/SIMULADO-NAO-PAGUE/)).toBeVisible();
  // Sem aprovação do provedor, o pedido continua pendente.
  const orderId = buyer.url().split("/checkout/")[1];
  await buyer.goto(`/pedido/${orderId}`);
  await expect(buyer.getByRole("heading", { name: /Aguardando confirmação/ })).toBeVisible();

  await buyer.goto(`/checkout/${orderId}`);
  await buyer.getByRole("button", { name: "Aprovar PIX" }).click();
  await buyer.waitForURL(/\/pedido\//);
  await expect(buyer.getByRole("heading", { name: "Pagamento confirmado!" })).toBeVisible();

  const ticketLink = buyer.locator('a[href^="/ingressos/"]').first();
  const code = (await ticketLink.getAttribute("href"))!.split("/").pop()!;
  await ticketLink.click();
  await expect(buyer.getByRole("img", { name: "QR code do ingresso" })).toBeVisible();
  await expect(buyer.getByText(code)).toBeVisible();
  // Voltar, imprimir e salvar em PDF (abre no visualizador do navegador).
  await expect(buyer.getByRole("link", { name: "Meus ingressos" }).first()).toBeVisible();
  await expect(buyer.getByRole("button", { name: "Imprimir" })).toBeVisible();
  const pdfLink = buyer.getByRole("link", { name: "Salvar PDF" });
  await expect(pdfLink).toHaveAttribute("target", "_blank");
  const pdf = await buyer.request.get((await pdfLink.getAttribute("href"))!);
  expect(pdf.status()).toBe(200);
  expect(pdf.headers()["content-type"]).toBe("application/pdf");
  expect(pdf.headers()["content-disposition"]).toMatch(/^inline;/);
  expect((await pdf.body()).subarray(0, 5).toString()).toBe("%PDF-");
  await buyer.getByRole("link", { name: "Ver pedido" }).click();
  await expect(buyer.getByRole("link", { name: "Salvar todos (PDF)" })).toBeVisible();
  const all = await buyer.request.get((await buyer.getByRole("link", { name: "Salvar todos (PDF)" }).getAttribute("href"))!);
  expect(all.status()).toBe(200);
  await buyer.goBack();
  await expect(buyer.getByRole("img", { name: "QR code do ingresso" })).toBeVisible();

  // Organizador valida na entrada
  const staff = await (await browser.newContext()).newPage();
  const { payload, eventId } = await qrPayloadFor(code);
  await openScanner(staff, USERS.producer, eventId);
  await expect(staff).toHaveURL(new RegExp(`/check-in/${eventId}`));
  const input = staff.getByPlaceholder(/Colar conteúdo do QR/);
  await input.fill(payload);
  await staff.getByRole("button", { name: "Validar" }).click();
  // O anunciador de rotas do Next também usa role=alert: filtramos pelo texto do resultado.
  const result = (text: string) => staff.getByRole("alert").filter({ hasText: text });
  await expect(result("Entrada liberada")).toBeVisible();
  await expect(result("Entrada liberada")).toContainText(code);
  await nextScan(staff);
  await input.fill(payload);
  await staff.getByRole("button", { name: "Validar" }).click();
  await expect(result("Ingresso JÁ UTILIZADO")).toBeVisible();

  // O comprador vê o ingresso como utilizado
  await buyer.reload();
  await expect(buyer.getByText("Ingresso já utilizado")).toBeVisible();
});

test("meia-entrada: a portaria vê o aviso para exigir o documento, também no duplicado", async ({ browser }) => {
  const buyer = await (await browser.newContext()).newPage();
  await login(buyer, USERS.customer, "/eventos/festival-litoral-sonoro-rio-de-janeiro");
  const meia = buyer.locator("li").filter({ hasText: "Meia-entrada" });
  await meia.getByRole("button", { name: "Aumentar" }).click();
  await buyer.getByRole("checkbox", { name: /direito à meia-entrada/ }).check();
  await buyer.getByRole("button", { name: "Continuar para revisão" }).click();
  await proceedThroughReview(buyer);
  await buyer.getByRole("button", { name: "Gerar PIX" }).click();
  await buyer.getByRole("button", { name: "Aprovar PIX" }).click();
  await buyer.waitForURL(/\/pedido\//);
  const code = (await buyer.locator('a[href^="/ingressos/"]').first().getAttribute("href"))!.split("/").pop()!;

  const staff = await (await browser.newContext()).newPage();
  const { payload, eventId } = await qrPayloadFor(code);
  await openScanner(staff, USERS.producer, eventId);
  const input = staff.getByPlaceholder(/Colar conteúdo do QR/);
  const result = (text: string) => staff.getByRole("alert").filter({ hasText: text });
  await input.fill(payload);
  await staff.getByRole("button", { name: "Validar" }).click();
  await expect(result("Entrada liberada")).toContainText("Meia-entrada — exigir documento comprobatório");
  await nextScan(staff);
  await input.fill(payload);
  await staff.getByRole("button", { name: "Validar" }).click();
  await expect(result("Ingresso JÁ UTILIZADO")).toContainText("Meia-entrada — exigir documento comprobatório");
});

test("check-in sem internet: valida com a lista baixada, guarda e confirma ao reconectar", async ({ browser }) => {
  const buyer = await (await browser.newContext()).newPage();
  await login(buyer, USERS.customer, "/eventos/festival-litoral-sonoro-rio-de-janeiro");
  await buyer.locator("li").filter({ hasText: "Inteira" }).first().getByRole("button", { name: "Aumentar" }).click();
  await buyer.getByRole("button", { name: "Continuar para revisão" }).click();
  await proceedThroughReview(buyer);
  await buyer.getByRole("button", { name: "Gerar PIX" }).click();
  await buyer.getByRole("button", { name: "Aprovar PIX" }).click();
  await buyer.waitForURL(/\/pedido\//);
  const code = (await buyer.locator('a[href^="/ingressos/"]').first().getAttribute("href"))!.split("/").pop()!;

  const ctx = await browser.newContext();
  const staff = await ctx.newPage();
  const { payload, eventId } = await qrPayloadFor(code);
  await openScanner(staff, USERS.producer, eventId);
  // Sem câmera no teste: a lanterna não aparece (só com câmera que a suporte).
  await expect(staff.getByRole("button", { name: /lanterna/i })).toHaveCount(0);

  await staff.getByRole("button", { name: "Baixar lista para uso offline" }).click();
  await expect(staff.getByText(/Lista baixada: \d+ ingressos/)).toBeVisible();

  await ctx.setOffline(true);
  await expect(staff.getByText(/Sem internet: validando com a lista baixada/)).toBeVisible();
  const input = staff.getByPlaceholder(/Colar conteúdo do QR/);
  const result = (text: string) => staff.getByRole("alert").filter({ hasText: text });
  await input.fill(payload);
  await staff.getByRole("button", { name: "Validar" }).click();
  await expect(result("Entrada liberada (offline)")).toBeVisible();
  await nextScan(staff);
  await input.fill(payload);
  await staff.getByRole("button", { name: "Validar" }).click();
  await expect(result("JÁ UTILIZADO neste aparelho")).toBeVisible();
  await nextScan(staff);
  await expect(staff.getByText("2 leituras guardadas para enviar.")).toBeVisible();

  // Conexão de volta: a fila vai sozinha para o servidor, que confirma a entrada.
  await ctx.setOffline(false);
  await expect(staff.getByRole("status").filter({ hasText: "2 leituras enviadas" })).toBeVisible();
  await input.fill(payload);
  await staff.getByRole("button", { name: "Validar" }).click();
  await expect(result("Ingresso JÁ UTILIZADO")).toBeVisible();
});

test("lista baixada prepara o leitor para abrir sem internet; sair da conta apaga os dados offline", async ({ browser }) => {
  const buyer = await (await browser.newContext()).newPage();
  await login(buyer, USERS.customer, "/eventos/festival-litoral-sonoro-rio-de-janeiro");
  await buyer.locator("li").filter({ hasText: "Inteira" }).first().getByRole("button", { name: "Aumentar" }).click();
  await buyer.getByRole("button", { name: "Continuar para revisão" }).click();
  await proceedThroughReview(buyer);
  await buyer.getByRole("button", { name: "Gerar PIX" }).click();
  await buyer.getByRole("button", { name: "Aprovar PIX" }).click();
  await buyer.waitForURL(/\/pedido\//);
  const code = (await buyer.locator('a[href^="/ingressos/"]').first().getAttribute("href"))!.split("/").pop()!;

  const ctx = await browser.newContext();
  const staff = await ctx.newPage();
  const { eventId } = await qrPayloadFor(code);
  await login(staff, USERS.producer, `/check-in/${eventId}`);
  const title = await staff.getByRole("heading", { level: 1 }).textContent();
  await staff.getByRole("button", { name: "Baixar lista para uso offline" }).click();
  await expect(staff.getByText(/pode ser aberto de novo sem internet/)).toBeVisible();
  // O worker guardou a página do leitor.
  await expect.poll(() => staff.evaluate(async () => (await caches.open("qqpega-checkin-v1")).match(location.origin + location.pathname).then(Boolean))).toBe(true);

  // Espera a cópia terminar (página + arquivos que ela referencia): contagem estável.
  let last = -1;
  await expect
    .poll(async () => {
      const n = await staff.evaluate(async () => (await (await caches.open("qqpega-checkin-v1")).keys()).length);
      const stable = n === last && n > 1;
      last = n;
      return stable;
    }, { intervals: [500] })
    .toBe(true);

  // Sem internet, recarregar abre o leitor a partir da cópia guardada pelo worker. (A página
  // voltar a ficar interativa offline depende do build de produção — o guia de offline do
  // Next diz que o `next dev` não é referência para isso — e foi conferida contra `next start`.)
  await ctx.setOffline(true);
  await staff.reload();
  await expect(staff.getByRole("heading", { level: 1 })).toHaveText(title!);
  await expect(staff.getByRole("button", { name: "Validar" })).toBeVisible();
  await ctx.setOffline(false);
  await staff.reload();
  await expect(staff.getByText(/Lista baixada às/)).toBeVisible();

  // Sair da conta apaga tudo o que o leitor offline guardou no aparelho.
  await staff.locator("header summary").filter({ hasText: "Menu da conta" }).click();
  await staff.locator("header").getByRole("button", { name: "Sair" }).click();
  await staff.waitForURL((u) => u.pathname === "/");
  const left = await staff.evaluate(async () => ({
    dbs: (await indexedDB.databases()).map((d) => d.name),
    caches: (await caches.keys()).filter((k) => k.startsWith("qqpega-checkin")),
    // Só o worker do leitor (escopo /check-in/); o do PWA na raiz não é dele.
    workers: (await navigator.serviceWorker.getRegistrations()).filter((r) => new URL(r.scope).pathname.startsWith("/check-in/")).length,
  }));
  expect(left).toEqual({ dbs: expect.not.arrayContaining(["qqpega-checkin"]), caches: [], workers: 0 });
});

/** Chaves guardadas pelo check-in offline (IndexedDB) e se há cópia do leitor/worker. */
async function offlineState(page: Page) {
  return page.evaluate(async () => {
    const keys: string[] = (await indexedDB.databases()).some((d) => d.name === "qqpega-checkin")
      ? await new Promise((resolve) => {
          const req = indexedDB.open("qqpega-checkin");
          req.onsuccess = () => {
            const db = req.result;
            const r = db.transaction("kv").objectStore("kv").getAllKeys();
            r.onsuccess = () => {
              db.close();
              resolve((r.result as IDBValidKey[]).map(String).sort());
            };
          };
        })
      : [];
    return {
      keys,
      caches: (await caches.keys()).filter((k) => k.startsWith("qqpega-checkin")).length,
      workers: (await navigator.serviceWorker.getRegistrations()).filter((r) => new URL(r.scope).pathname.startsWith("/check-in/")).length,
    };
  });
}

test("sessão expirada apaga a lista e a cópia do leitor, mas guarda as leituras pendentes até entrar de novo", async ({ browser }) => {
  const buyer = await (await browser.newContext()).newPage();
  await login(buyer, USERS.customer, "/eventos/festival-litoral-sonoro-rio-de-janeiro");
  await buyer.locator("li").filter({ hasText: "Inteira" }).first().getByRole("button", { name: "Aumentar" }).click();
  await buyer.getByRole("button", { name: "Continuar para revisão" }).click();
  await proceedThroughReview(buyer);
  await buyer.getByRole("button", { name: "Gerar PIX" }).click();
  await buyer.getByRole("button", { name: "Aprovar PIX" }).click();
  await buyer.waitForURL(/\/pedido\//);
  const code = (await buyer.locator('a[href^="/ingressos/"]').first().getAttribute("href"))!.split("/").pop()!;

  const ctx = await browser.newContext();
  const staff = await ctx.newPage();
  const { payload, eventId } = await qrPayloadFor(code);
  await openScanner(staff, USERS.producer, eventId);
  await staff.getByRole("button", { name: "Baixar lista para uso offline" }).click();
  await expect(staff.getByText(/Lista baixada: \d+ ingressos/)).toBeVisible();
  await expect.poll(async () => (await offlineState(staff)).caches).toBe(1);

  await ctx.setOffline(true);
  await staff.getByPlaceholder(/Colar conteúdo do QR/).fill(payload);
  await staff.getByRole("button", { name: "Validar" }).click();
  await expect(staff.getByRole("alert").filter({ hasText: "Entrada liberada (offline)" })).toBeVisible();
  await nextScan(staff);
  // Relógio de volta ao normal: parado, o streaming das próximas páginas não termina.
  await staff.clock.resume();

  // A sessão expira (o cookie some) e a próxima página já abre sem login.
  await ctx.clearCookies();
  await ctx.setOffline(false);
  await staff.goto("/");
  await expect(staff.getByRole("link", { name: "Entrar", exact: true })).toBeVisible();
  await expect.poll(() => offlineState(staff)).toEqual({ keys: [`queue:${eventId}`], caches: 0, workers: 0 });

  // Entrando de novo, a leitura guardada é enviada e a entrada fica registrada.
  await login(staff, USERS.producer, `/check-in/${eventId}`);
  await expect(staff.getByRole("status").filter({ hasText: "1 leitura enviada" })).toBeVisible();
  await expect(staff.getByText("offline", { exact: true }).first()).toBeVisible();
});

test("sair com leituras offline não enviadas: avisa, envia e só então sai", async ({ browser }) => {
  const buyer = await (await browser.newContext()).newPage();
  await login(buyer, USERS.customer, "/eventos/festival-litoral-sonoro-rio-de-janeiro");
  await buyer.locator("li").filter({ hasText: "Inteira" }).first().getByRole("button", { name: "Aumentar" }).click();
  await buyer.getByRole("button", { name: "Continuar para revisão" }).click();
  await proceedThroughReview(buyer);
  await buyer.getByRole("button", { name: "Gerar PIX" }).click();
  await buyer.getByRole("button", { name: "Aprovar PIX" }).click();
  await buyer.waitForURL(/\/pedido\//);
  const code = (await buyer.locator('a[href^="/ingressos/"]').first().getAttribute("href"))!.split("/").pop()!;

  const ctx = await browser.newContext();
  const staff = await ctx.newPage();
  const { payload, eventId } = await qrPayloadFor(code);
  await openScanner(staff, USERS.producer, eventId);
  await staff.getByRole("button", { name: "Baixar lista para uso offline" }).click();
  await expect(staff.getByText(/Lista baixada: \d+ ingressos/)).toBeVisible();
  await ctx.setOffline(true);
  await staff.getByPlaceholder(/Colar conteúdo do QR/).fill(payload);
  await staff.getByRole("button", { name: "Validar" }).click();
  await expect(staff.getByRole("alert").filter({ hasText: "Entrada liberada (offline)" })).toBeVisible();
  await nextScan(staff);
  await staff.clock.resume();

  // Sair sem internet: o aviso aparece e "Enviar e sair" espera a conexão.
  const logout = async () => {
    await staff.locator("header summary").filter({ hasText: "Menu da conta" }).click();
    await staff.locator("header").getByRole("button", { name: "Sair" }).click();
  };
  await logout();
  const dialog = staff.getByRole("dialog", { name: "1 leitura do check-in ainda não foi enviada" });
  await expect(dialog).toBeVisible();
  await expect(dialog.getByText("Sem internet: conecte o aparelho para enviar.")).toBeVisible();
  await expect(dialog.getByRole("button", { name: "Enviar e sair" })).toBeDisabled();
  // Cancelar mantém a sessão e a leitura guardada.
  await dialog.getByRole("button", { name: "Cancelar" }).click();
  await expect(dialog).toBeHidden();
  await expect(staff.getByText("1 leitura guardada para enviar.")).toBeVisible();

  await logout();
  await expect(dialog).toBeVisible();
  await ctx.setOffline(false);
  await dialog.getByRole("button", { name: "Enviar e sair" }).click();
  await staff.waitForURL((u) => u.pathname === "/");
  await expect.poll(() => offlineState(staff)).toEqual({ keys: [], caches: 0, workers: 0 });

  // A entrada chegou ao servidor antes do logout.
  const client = new pg.Client({ connectionString: process.env.DATABASE_URL });
  await client.connect();
  const { rows } = await client.query('SELECT status FROM "IssuedTicket" WHERE code = $1', [code]);
  await client.end();
  expect(rows[0].status).toBe("CHECKED_IN");
});

test("conta que perdeu o acesso ao evento: o leitor some e a lista offline do evento é apagada", async ({ browser }) => {
  const client = new pg.Client({ connectionString: process.env.DATABASE_URL });
  await client.connect();
  const { rows } = await client.query('SELECT a.* FROM "EventStaffAssignment" a JOIN "User" u ON u.id = a."userId" WHERE u.email = $1 LIMIT 1', [STAFF]);
  const assignment = rows[0];
  expect(assignment, "atribuição da portaria demo").toBeTruthy();
  const eventId = assignment.eventId as string;
  try {
    const staff = await (await browser.newContext()).newPage();
    await login(staff, STAFF, `/check-in/${eventId}`);
    await staff.getByRole("button", { name: "Baixar lista para uso offline" }).click();
    await expect(staff.getByText(/Lista baixada: \d+ ingressos/)).toBeVisible();
    await expect.poll(async () => (await offlineState(staff)).keys).toContain(`pkg:${eventId}`);
    await expect.poll(() => staff.evaluate(async (id) => !!(await caches.match(`${location.origin}/check-in/${id}`)), eventId)).toBe(true);

    // O organizador tira a pessoa da portaria do evento.
    await client.query('DELETE FROM "EventStaffAssignment" WHERE id = $1', [assignment.id]);
    await staff.reload();
    await expect(staff.getByRole("heading", { name: "Leitor indisponível" })).toBeVisible();
    await expect.poll(async () => (await offlineState(staff)).keys.filter((k) => k.endsWith(`:${eventId}`))).toEqual([]);
    await expect.poll(() => staff.evaluate(async (id) => !!(await caches.match(`${location.origin}/check-in/${id}`)), eventId)).toBe(false);
  } finally {
    const cols = Object.keys(assignment);
    await client.query(
      `INSERT INTO "EventStaffAssignment" (${cols.map((c) => `"${c}"`).join(", ")}) VALUES (${cols.map((_, i) => `$${i + 1}`).join(", ")}) ON CONFLICT DO NOTHING`,
      cols.map((c) => assignment[c]),
    );
    await client.end();
  }
});
