// Fase 4 (paginas-publicas): telas do comprador sobre o seed de demonstração —
// transferência, reembolso pela janela de alteração e pedido de cancelamento.
import pg from "pg";
import { expect, test } from "@playwright/test";
import { login, qrPayloadFor, USERS } from "./helpers";

const FRIEND = "amiga@demo.eventobrasil.test";

/** Other specs may refund the Festival seed order; resolve actual transferable inventory. */
async function transferableCustomerTicket() {
  const client = new pg.Client({ connectionString: process.env.DATABASE_URL });
  await client.connect();
  try {
    const { rows } = await client.query<{ code: string; title: string }>(`
      SELECT t.code, e.title
      FROM "IssuedTicket" t
      JOIN "User" u ON u.id = t."holderUserId"
      JOIN "Order" o ON o.id = t."orderId"
      JOIN "Event" e ON e.id = t."eventId"
      WHERE u.email = $1 AND t.status = 'VALID' AND o.status = 'PAID'
        AND e.status = 'PUBLISHED'
        AND e."startsAt" - e."transferDeadlineHours" * interval '1 hour' > now()
        AND EXISTS (
          SELECT 1 FROM "OrganizationMember" m JOIN "User" producer ON producer.id = m."userId"
          WHERE m."organizationId" = e."organizationId" AND producer.email = $2 AND m.role = 'OWNER'
        )
        AND NOT EXISTS (SELECT 1 FROM "TicketTransfer" pending WHERE pending."ticketId" = t.id AND pending.status = 'PENDING')
        AND (SELECT count(*) FROM "TicketTransfer" accepted WHERE accepted."ticketId" = t.id AND accepted.status = 'ACCEPTED') < e."transferMaxTransfers"
      ORDER BY t.id LIMIT 1`, [USERS.customer, USERS.producer]);
    expect(rows[0], "Ingresso válido e transferível do cliente em evento do produtor").toBeTruthy();
    return rows[0];
  } finally {
    await client.end();
  }
}

test("transferência: envia em Meus ingressos → outra conta aceita → QR antigo recusado na portaria", async ({ browser }) => {
  test.skip(process.env.E2E_ISOLATED !== "1", "Transferência e check-in somente no banco descartável do E2E isolado.");
  const { code, title } = await transferableCustomerTicket();
  const sender = await (await browser.newContext()).newPage();
  await login(sender, USERS.customer, "/meus-ingressos");
  const before = await qrPayloadFor(code);

  // Link da página do ingresso (contrato com check-in): já abre o formulário daquele ingresso.
  await sender.goto(`/meus-ingressos?transferir=${code}`);
  const form = sender.locator(`#ingresso-${code}`);
  await expect(form.getByTestId("transfer-rules")).toContainText("gratuita");
  await expect(form.getByTestId("transfer-rules")).toContainText("deixam de valer");
  await form.getByLabel("Nome de quem vai receber").fill("Ana Amiga");
  await form.getByLabel("E-mail de quem vai receber").fill(FRIEND);
  await form.getByRole("button", { name: "Continuar" }).click();
  await form.getByRole("button", { name: "Sim, transferir" }).click();
  await expect(sender.locator(`#ingresso-${code}`).getByTestId("outgoing-transfer")).toContainText(FRIEND);

  // A amiga aceita na própria lista.
  const friend = await (await browser.newContext()).newPage();
  await login(friend, FRIEND, "/meus-ingressos");
  const incoming = friend.getByTestId("incoming-transfer").filter({ hasText: title });
  await expect(incoming).toBeVisible();
  await incoming.getByRole("button", { name: "Aceitar" }).click();
  // Aceita: vai para o ingresso, agora no nome dela.
  await friend.waitForURL(new RegExp(`/ingressos/${code}$`));
  await friend.goto("/meus-ingressos");
  await expect(friend.locator(`#ingresso-${code}`)).toBeVisible();
  await expect(friend.getByTestId("incoming-transfer").filter({ hasText: title })).toHaveCount(0);

  // Quem enviou vê o histórico; o ingresso sai da lista.
  await sender.reload();
  await expect(sender.getByTestId("transferred-away").filter({ hasText: title }).first()).toContainText("Ana Amiga");
  await expect(sender.locator(`#ingresso-${code}`)).toHaveCount(0);

  // Portaria: o QR antigo não vale; o novo libera a entrada.
  const after = await qrPayloadFor(code);
  expect(after.payload).not.toBe(before.payload);
  const staff = await (await browser.newContext()).newPage();
  await login(staff, USERS.producer, `/check-in/${before.eventId}`);
  const input = staff.getByPlaceholder(/Colar conteúdo do QR/);
  const result = (text: string | RegExp) => staff.getByRole("alert").filter({ hasText: text });
  await input.fill(before.payload);
  await staff.getByRole("button", { name: "Validar" }).click();
  await expect(result(/inválido/i)).toBeVisible();
  await staff.waitForTimeout(2600);
  await input.fill(after.payload);
  await staff.getByRole("button", { name: "Validar" }).click();
  await expect(result("Entrada liberada")).toContainText(code);
});

test("alteração relevante: o pedido mostra o que mudou e o reembolso integral até a data", async ({ page }) => {
  test.skip(process.env.E2E_ISOLATED !== "1", "Reembolso somente no banco descartável do E2E isolado.");
  await login(page, USERS.customer, "/meus-pedidos");
  await page.getByRole("link").filter({ hasText: "Pôr do Sol Eletrônico" }).first().click();
  await page.waitForURL(/\/pedido\//);
  const card = page.getByTestId("event-change-window");
  await expect(card).toContainText("O evento foi alterado depois da sua compra");
  await expect(card).toContainText("Atraso na montagem do palco");
  await expect(card.getByTestId("change-refund-until")).toHaveText(/^\d{2}\/\d{2}\/\d{4}$/);
  await card.getByRole("button", { name: "Solicitar reembolso" }).click();
  await card.getByRole("button", { name: "Sim, reembolsar" }).click();
  // A página se atualiza: a janela some e o aviso de reembolso aparece no topo.
  await expect(page.getByTestId("event-change-window")).toHaveCount(0);
  await expect(page.getByText(/Reembolso (concluído|solicitado|em andamento)/).first()).toBeVisible();
  await expect(page.getByRole("heading", { level: 1 })).toHaveText(/Reembols/);
});

test("pedido de cancelamento: pela central de ajuda, com protocolo, e listado nos pedidos", async ({ page }) => {
  test.skip(process.env.E2E_ISOLATED !== "1", "Pedido de cancelamento somente no banco descartável do E2E isolado.");
  await login(page, USERS.customer, "/ajuda#cancelamento");
  // O pedido do Festival já tem um aberto (seed): aparece com o protocolo.
  await expect(page.getByTestId("cancellation-requests")).toContainText("SEED01");
  await page.getByRole("button", { name: "Solicitar cancelamento" }).click();
  await page.getByLabel("Pedido").selectOption({ label: (await page.getByLabel("Pedido").locator("option", { hasText: "Axé de Rua" }).first().textContent())! });
  await page.getByLabel("Motivo do cancelamento").fill("Mudança de planos: não vou conseguir ir (teste e2e).");
  await page.getByRole("button", { name: "Enviar pedido de cancelamento" }).click();
  const done = page.getByTestId("cancellation-protocol");
  await expect(done).toContainText(/CAN-\d{8}-[0-9A-Z]{6}/);
  await expect(done).toContainText("resposta até");
  const protocol = (await done.locator("strong.font-mono").textContent())!;

  await page.goto("/meus-pedidos");
  const list = page.getByTestId("cancellation-requests");
  await expect(list).toContainText(protocol);
  await list.getByRole("link").filter({ hasText: "Axé de Rua" }).first().click();
  await page.waitForURL(/\/pedido\//);
  // A rota anterior fica montada e oculta (Activity do Next 16): só o que está visível.
  const onOrder = page.getByTestId("cancellation-requests").filter({ visible: true });
  await expect(onOrder).toContainText(protocol);
  await expect(onOrder).toContainText("Em análise");
  // Com um aberto, o formulário some da página do pedido.
  await expect(page.getByRole("button", { name: "Solicitar cancelamento" }).filter({ visible: true })).toHaveCount(0);
});

test("evento mostra o organizador responsável (L10b), sem CPF", async ({ page }) => {
  await page.goto("/eventos/festival-litoral-sonoro-rio-de-janeiro");
  const id = page.getByTestId("organizer-identification");
  await expect(id).toBeVisible();
  await expect(id).toHaveText(/^(Razão social|Responsável): .+/);
  await expect(id).not.toContainText(/\d{3}\.\d{3}\.\d{3}-\d{2}/);
});
