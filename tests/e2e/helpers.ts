import "dotenv/config";
import { expect, type Page } from "@playwright/test";
import pg from "pg";

export const DEMO_PASSWORD = "Demo@2026!";
export const USERS = {
  customer: "cliente@demo.eventobrasil.test",
  producer: "produtora@demo.eventobrasil.test",
  admin: "admin@demo.eventobrasil.test",
};

export async function login(page: Page, email: string, next = "/") {
  await page.goto(`/entrar?next=${encodeURIComponent(next)}`);
  await page.getByLabel("E-mail", { exact: true }).fill(email);
  await page.getByLabel("Senha", { exact: true }).fill(DEMO_PASSWORD);
  await page.getByRole("button", { name: "Entrar", exact: true }).click();
  await page.waitForURL((url) => !url.pathname.startsWith("/entrar"));
}

/** Marca os dois aceites do cadastro (termos de uso e política de privacidade, R10). */
export async function acceptSignupTerms(page: Page) {
  await page.getByRole("checkbox", { name: /termos de uso/ }).check();
  await page.getByRole("checkbox", { name: /política de privacidade/ }).check();
}

/** Lê o conteúdo do QR direto do banco de desenvolvimento (equivale a ler o QR com a câmera). */
export async function qrPayloadFor(code: string) {
  const client = new pg.Client({ connectionString: process.env.DATABASE_URL });
  await client.connect();
  const { rows } = await client.query('SELECT code, "validationToken", "eventId" FROM "IssuedTicket" WHERE code = $1', [code]);
  await client.end();
  expect(rows[0], `ingresso ${code}`).toBeTruthy();
  return { payload: `EB1:${rows[0].code}:${rows[0].validationToken}`, eventId: rows[0].eventId as string };
}

/**
 * Cupom de 10% e link rastreado novos no evento de demonstração (código único por
 * execução e sem limite por comprador, para o teste poder repetir). Equivale ao
 * produtor criando os dois no painel.
 */
export async function createCouponLink(eventSlug: string) {
  const client = new pg.Client({ connectionString: process.env.DATABASE_URL });
  await client.connect();
  const stamp = Date.now().toString(36).toUpperCase();
  const { rows } = await client.query('SELECT e.id, e."organizationId", u.id AS "userId" FROM "Event" e, "User" u WHERE e.slug = $1 AND u.email = $2', [eventSlug, USERS.producer]);
  expect(rows[0], `evento ${eventSlug}`).toBeTruthy();
  const { id: eventId, organizationId, userId } = rows[0];
  const couponCode = `E2E${stamp}`;
  const linkCode = `e2e${stamp}`.slice(0, 16);
  const couponId = `ce2e${stamp.toLowerCase()}`;
  await client.query(
    `INSERT INTO "Coupon" (id, "organizationId", "eventId", code, "discountType", "percentBps", "maxUsesPerUser", "createdById", "updatedAt")
     VALUES ($1, $2, $3, $4, 'PERCENT', 1000, NULL, $5, now())`,
    [couponId, organizationId, eventId, couponCode, userId],
  );
  await client.query(
    `INSERT INTO "TrackingLink" (id, "organizationId", "eventId", code, name, "utmSource", "couponId", "createdById")
     VALUES ($1, $2, $3, $4, 'E2E', 'e2e', $5, $6)`,
    [`le2e${stamp.toLowerCase()}`, organizationId, eventId, linkCode, couponId, userId],
  );
  await client.end();
  return { couponCode, linkCode };
}

/** The new checkout requires an explicit authoritative review before payment. */
export async function proceedThroughReview(page: Page) {
  await page.waitForURL(/\/checkout\/revisao\//);
  await expect(page.getByRole("heading", { name: "Revise sua compra", exact: true })).toBeVisible();
  const prepare=page.getByRole("button", { name: "Revisar valores e ingressos", exact: true });
  await expect(prepare.or(page.getByRole("button", { name: "Confirmar e ir para pagamento", exact: true }))).toBeVisible();
  if(await prepare.isVisible()) await prepare.click();
  const confirm=page.getByRole("button", { name: "Confirmar e ir para pagamento", exact: true });
  await expect(confirm).toBeEnabled();
  await confirm.click();
  await page.waitForURL(url=>!url.pathname.startsWith("/checkout/revisao/"));
}
