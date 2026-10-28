// T-TRANSF (R6), Fase 4: estados da página de aceite /transferencia/[token] e avisos na
// página do ingresso. Os convites são gravados direto no banco (o formulário de
// transferência é de paginas-publicas); o token vai no link e só o HMAC fica no banco,
// como no serviço. Só roda no banco descartável (npm run test:e2e:isolated).
import { createHmac, randomBytes } from "node:crypto";
import { expect, test } from "@playwright/test";
import pg from "pg";
import { login, USERS } from "./helpers";

const FRIEND = "amiga@demo.eventobrasil.test";

test.skip(!process.env.E2E_ISOLATED, "grava transferências no banco: só no banco descartável do e2e isolado");

async function sql<T extends pg.QueryResultRow>(text: string, params: unknown[] = []) {
  const client = new pg.Client({ connectionString: process.env.DATABASE_URL });
  await client.connect();
  try {
    return (await client.query<T>(text, params)).rows;
  } finally {
    await client.end();
  }
}

/** Ingressos da cliente demo que ainda podem ser transferidos (VALID, pago, evento futuro, sem pendente). */
async function transferableTickets(n: number) {
  const rows = await sql<{ id: string; code: string; eventId: string; userId: string; holderName: string }>(
    `SELECT t.id, t.code, t."eventId", u.id AS "userId", COALESCE(t."holderName", u.name) AS "holderName"
       FROM "IssuedTicket" t
       JOIN "User" u ON u.id = t."holderUserId" AND u.email = $1
       JOIN "Order" o ON o.id = t."orderId" AND o.status = 'PAID'
       JOIN "Event" e ON e.id = t."eventId" AND e.status = 'PUBLISHED' AND e."startsAt" > now() + interval '2 days'
      WHERE t.status = 'VALID'
        AND NOT EXISTS (SELECT 1 FROM "TicketTransfer" tt WHERE tt."ticketId" = t.id AND tt.status = 'PENDING')
      ORDER BY t.code LIMIT $2`,
    [USERS.customer, n],
  );
  expect(rows.length, "ingressos transferíveis da cliente demo no seed").toBe(n);
  return rows;
}

/** Convite PENDING como o serviço grava; devolve o token do link. */
async function invite(ticket: { id: string; eventId: string; userId: string; holderName: string }, toEmail: string, opts: { expired?: boolean } = {}) {
  const token = randomBytes(32).toString("base64url");
  const tokenHash = createHmac("sha256", process.env.AUTH_SECRET!).update(token).digest("hex");
  const createdAt = opts.expired ? "now() - interval '3 days'" : "now()";
  const expiresAt = opts.expired ? "now() - interval '1 day'" : "now() + interval '1 day'";
  await sql(
    `INSERT INTO "TicketTransfer" (id, "ticketId", "eventId", "fromUserId", "fromHolderName", "fromHolderEmail", "toEmail", "toHolderName", "tokenHash", "createdById", "createdAt", "expiresAt")
     VALUES ($1, $2, $3, $4, $5, $6, $7, 'Ana Amiga (demo)', $8, $4, ${createdAt}, ${expiresAt})`,
    [`e2e${randomBytes(8).toString("hex")}`, ticket.id, ticket.eventId, ticket.userId, ticket.holderName, USERS.customer, toEmail, tokenHash],
  );
  return token;
}

test("aceite de transferência: expirado, conta errada, enviado por você, sucesso e link já usado", async ({ page, context }) => {
  const [stale, live] = await transferableTickets(2);
  const expiredToken = await invite(stale, FRIEND, { expired: true });
  const token = await invite(live, FRIEND);

  // Link adulterado.
  await login(page, USERS.producer, "/");
  await page.goto(`/transferencia/${"x".repeat(43)}`);
  await expect(page.getByText("Link de transferência inválido")).toBeVisible();

  // Conta errada: não mostra o ingresso; e-mail do destinatário mascarado.
  await page.goto(`/transferencia/${token}`);
  await expect(page.getByText("Você está na conta errada")).toBeVisible();
  await expect(page.getByText("am***@demo.eventobrasil.test")).toBeVisible();
  await expect(page.getByRole("button", { name: "Aceitar ingresso" })).toHaveCount(0);

  // Quem enviou.
  await context.clearCookies();
  await login(page, USERS.customer, "/");
  await page.goto(`/transferencia/${token}`);
  await expect(page.getByText("Esta transferência foi enviada por você")).toBeVisible();
  // A página do ingresso mostra a pendente e esconde "Transferir".
  await page.goto(`/ingressos/${live.code}`);
  await expect(page.getByText(/Transferência pendente para/)).toBeVisible();
  await expect(page.getByRole("link", { name: "Transferir ingresso" })).toHaveCount(0);
  // Ingresso sem pendente: o botão leva ao formulário em Meus ingressos.
  await page.goto(`/ingressos/${stale.code}`);
  await expect(page.getByRole("link", { name: "Transferir ingresso" })).toHaveAttribute("href", `/meus-ingressos?transferir=${stale.code}`);
  await expect(page.getByText(/Organizador responsável:/)).toBeVisible();

  // Destinatária: expirado, depois aceite com sucesso.
  await context.clearCookies();
  await login(page, FRIEND, "/");
  await page.goto(`/transferencia/${expiredToken}`);
  await expect(page.getByText("Convite expirado")).toBeVisible();

  await page.goto(`/transferencia/${token}`);
  await page.getByRole("button", { name: "Aceitar ingresso" }).click();
  await page.waitForURL(`**/ingressos/${live.code}`);
  await expect(page.getByText(/Recebido por transferência de/)).toBeVisible();
  await expect(page.getByRole("img", { name: "QR code do ingresso" })).toBeVisible();

  // Link de uso único.
  await page.goto(`/transferencia/${token}`);
  await expect(page.getByText("Você já aceitou esta transferência")).toBeVisible();

  // Quem transferiu vê o aviso, sem QR.
  await context.clearCookies();
  await login(page, USERS.customer, "/");
  await page.goto(`/ingressos/${live.code}`);
  await expect(page.getByText("Você transferiu este ingresso")).toBeVisible();
  await expect(page.getByRole("img", { name: "QR code do ingresso" })).toHaveCount(0);
});
