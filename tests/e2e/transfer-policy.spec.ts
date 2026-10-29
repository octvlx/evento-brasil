import { randomBytes, randomUUID } from "node:crypto";
import pg from "pg";
import { expect, test, type Page } from "@playwright/test";
import { login, USERS } from "./helpers";
import { formatDateTimeShort, timezoneLabel } from "../../src/lib/datetime";

const FRIEND = "amiga@demo.eventobrasil.test";
const HOUR = 3_600_000;

test.skip(process.env.E2E_ISOLATED !== "1", "Cria dados exclusivos somente no PostgreSQL descartável do E2E isolado.");

/** A complete, separate event/order/ticket fixture; never edits shared seeded events. */
async function eventWithTicket(hoursUntilStart = 7 * 24) {
  const client = new pg.Client({ connectionString: process.env.DATABASE_URL });
  await client.connect();
  try {
    await client.query("BEGIN");
    const { rows } = await client.query(`
      SELECT row_to_json(e) AS event, row_to_json(tt) AS type, row_to_json(o) AS "order",
             row_to_json(oi) AS item, row_to_json(t) AS ticket
      FROM "IssuedTicket" t
      JOIN "User" u ON u.id = t."holderUserId"
      JOIN "Event" e ON e.id = t."eventId"
      JOIN "TicketType" tt ON tt.id = t."ticketTypeId"
      JOIN "Order" o ON o.id = t."orderId"
      JOIN "OrderItem" oi ON oi.id = t."orderItemId"
      WHERE u.email = $1 AND t.status = 'VALID' AND o.status = 'PAID'
        AND EXISTS (
          SELECT 1 FROM "OrganizationMember" m JOIN "User" producer ON producer.id = m."userId"
          WHERE m."organizationId" = e."organizationId" AND producer.email = $2 AND m.role = 'OWNER'
        )
      ORDER BY t.id LIMIT 1`, [USERS.customer, USERS.producer]);
    expect(rows[0], "Ingresso pago de demonstração para copiar somente no banco descartável").toBeTruthy();
    const source = rows[0];
    const suffix = randomUUID();
    const id = `policy-event-${suffix}`;
    const title = `Política de transferência ${suffix}`;
    const slug = `politica-transferencia-${suffix}`;
    const typeId = `policy-type-${suffix}`;
    const orderId = `policy-order-${suffix}`;
    const itemId = `policy-item-${suffix}`;
    const ticketId = `policy-ticket-${suffix}`;
    const code = randomBytes(8).toString("hex").toUpperCase();
    const startsAt = new Date(Date.now() + hoursUntilStart * HOUR);
    const timezone = "America/Manaus";
    const insert = async (table: string, record: Record<string, unknown>) => {
      // Table names are constants owned by this helper, never user input.
      await client.query(`INSERT INTO "${table}" SELECT * FROM json_populate_record(NULL::"${table}", $1::json)`, [JSON.stringify(record)]);
    };
    await insert("Event", {
      ...source.event, id, title, slug, startsAt, endsAt: new Date(startsAt.getTime() + 8 * HOUR), timezone,
      salesStartAt: new Date(Date.now() - HOUR), salesEndAt: new Date(startsAt.getTime() - HOUR),
      capacity: 100, maxTicketsPerAccount: null, transferDeadlineHours: 24, transferMaxTransfers: 1, transferAllowReturn: false,
    });
    await insert("TicketType", { ...source.type, id: typeId, eventId: id, quantityTotal: 100, quantityReserved: 0, quantitySold: 1, quantityRefunded: 0, salesStartAt: null, salesEndAt: null });
    await insert("Order", {
      ...source.order, id: orderId, publicCode: `POL-${suffix}`, eventId: id, idempotencyKey: suffix,
      couponId: null, couponCode: null, trackingLinkId: null, discountCents: source.item.discountPerUnitCents,
      subtotalCents: source.item.unitPriceCents, serviceFeeCents: source.item.serviceFeePerUnitCents,
      totalCents: source.item.unitPriceCents + source.item.serviceFeePerUnitCents, commissionCents: source.item.commissionPerUnitCents,
    });
    await insert("OrderItem", { ...source.item, id: itemId, orderId, ticketTypeId: typeId, quantity: 1 });
    await insert("IssuedTicket", {
      ...source.ticket, id: ticketId, code, orderId, orderItemId: itemId, eventId: id, ticketTypeId: typeId,
      sequence: 1, validationToken: randomBytes(32).toString("hex"),
    });
    await client.query("COMMIT");
    return { id, title, slug, code, startsAt, timezone };
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    await client.end();
  }
}

async function sendTicket(page: Page, code: string, toEmail: string, toName: string) {
  await page.goto(`/meus-ingressos?transferir=${code}`);
  const row = page.locator(`#ingresso-${code}`);
  await row.getByLabel("Nome de quem vai receber").fill(toName);
  await row.getByLabel("E-mail de quem vai receber").fill(toEmail);
  await row.getByRole("button", { name: "Continuar", exact: true }).click();
  await row.getByRole("button", { name: "Sim, transferir", exact: true }).click();
  await expect(row.getByTestId("outgoing-transfer")).toContainText(toEmail);
}

async function acceptTicket(page: Page, fixture: { title: string; code: string }) {
  await page.goto("/meus-ingressos");
  const incoming = page.getByTestId("incoming-transfer").filter({ hasText: fixture.title });
  await incoming.getByRole("button", { name: "Aceitar", exact: true }).click();
  await expect(page).toHaveURL(new RegExp(`/ingressos/${fixture.code}$`));
}

test("padrão: prazo de 24h, um único aceite e sem desfazer após transferir", async ({ page, browser }) => {
  const fixture = await eventWithTicket();
  const cutoff = new Date(fixture.startsAt.getTime() - 24 * HOUR);
  await page.goto(`/eventos/${fixture.slug}`);
  const publicRules = page.getByTestId("transfer-rules");
  await expect(publicRules).toContainText(formatDateTimeShort(cutoff, fixture.timezone));
  await expect(publicRules).toContainText(timezoneLabel(cutoff, fixture.timezone));
  await expect(publicRules).toContainText("24 horas antes");
  await expect(publicRules).toContainText("no máximo 1 transferência aceita");
  await expect(publicRules).toContainText("não é possível desfazer nem devolver");
  await expect(publicRules).not.toContainText("provisório");

  await login(page, USERS.customer, `/meus-ingressos?transferir=${fixture.code}`);
  await expect(page.locator(`#ingresso-${fixture.code}`).getByTestId("transfer-rules")).toContainText("solicitação e o aceite");
  await sendTicket(page, fixture.code, FRIEND, "Ana Amiga");
  const friendContext = await browser.newContext();
  try {
    const friend = await friendContext.newPage();
    await login(friend, FRIEND, "/meus-ingressos");
    await acceptTicket(friend, fixture);
    await friend.goto(`/meus-ingressos?transferir=${fixture.code}`);
    const row = friend.locator(`#ingresso-${fixture.code}`);
    await expect(row.getByTestId("transfer-unavailable")).toContainText("Limite de transferências atingido");
    await expect(row.getByRole("button", { name: /^Transferir/ })).toHaveCount(0);
    await expect(row.getByRole("button", { name: /desfazer|devolver/i })).toHaveCount(0);
  } finally {
    await friendContext.close();
  }
});

test("regra salva pelo organizador aparece antes da compra e permite devolução com novo aceite", async ({ page, browser }) => {
  test.setTimeout(120_000);
  const fixture = await eventWithTicket();
  await login(page, USERS.producer, `/organizador/eventos/${fixture.id}/editar`);
  await page.getByLabel("Transferência: horas antes do início", { exact: true }).fill("6");
  await page.getByLabel("Máximo de transferências por ingresso", { exact: true }).fill("3");
  await page.getByLabel("Permitir nova transferência para um titular anterior", { exact: true }).check();
  await page.getByRole("button", { name: "Salvar alterações", exact: true }).click();
  await expect(page.getByText("Evento salvo.", { exact: true })).toBeVisible();
  await page.reload();
  await expect(page.getByLabel("Transferência: horas antes do início", { exact: true })).toHaveValue("6");
  await expect(page.getByLabel("Máximo de transferências por ingresso", { exact: true })).toHaveValue("3");
  await expect(page.getByLabel("Permitir nova transferência para um titular anterior", { exact: true })).toBeChecked();
  await page.goto(`/eventos/${fixture.slug}`);
  const publicRules = page.getByTestId("transfer-rules");
  await expect(publicRules).toContainText("6 horas antes");
  await expect(publicRules).toContainText("no máximo 3 transferências aceitas");
  await expect(publicRules).toContainText("devolução a um titular anterior exige uma nova transferência");

  const buyerContext = await browser.newContext();
  const friendContext = await browser.newContext();
  try {
    const buyer = await buyerContext.newPage();
    const friend = await friendContext.newPage();
    await login(buyer, USERS.customer, "/meus-ingressos");
    await sendTicket(buyer, fixture.code, FRIEND, "Ana Amiga");
    await login(friend, FRIEND, "/meus-ingressos");
    await acceptTicket(friend, fixture);
    await sendTicket(friend, fixture.code, USERS.customer, "Clara Cliente");
    // Initiating a return does not change ownership; only the original payer's fresh consent does.
    await expect(friend.locator(`#ingresso-${fixture.code}`)).toBeVisible();
    await acceptTicket(buyer, fixture);
    await buyer.goto(`/meus-ingressos?transferir=${fixture.code}`);
    await expect(buyer.locator(`#ingresso-${fixture.code}`).getByTestId("transfer-rules")).toContainText("no máximo 3 transferências aceitas");
  } finally {
    await buyerContext.close();
    await friendContext.close();
  }
});

test("prazo de 24h já encerrado esconde a transferência mesmo antes de começar o evento", async ({ page }) => {
  const fixture = await eventWithTicket(12);
  await login(page, USERS.customer, `/meus-ingressos?transferir=${fixture.code}`);
  const row = page.locator(`#ingresso-${fixture.code}`);
  await expect(row.getByTestId("transfer-unavailable")).toContainText("Prazo para solicitar e aceitar transferências encerrado");
  await expect(row.getByRole("button", { name: /^Transferir/ })).toHaveCount(0);
  await expect(row.getByLabel("Nome de quem vai receber")).toHaveCount(0);
});
