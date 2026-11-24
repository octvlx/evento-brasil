import "dotenv/config";
import { expect, type Page } from "@playwright/test";
import { createECDH, createHmac, createPrivateKey, sign } from "node:crypto";
import { readFile } from "node:fs/promises";
import path from "node:path";
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

/**
 * Abre o leitor da portaria com o relógio da página parado. O leitor mostra cada
 * resultado por 1,5–2,2 s e depois limpa a tela; no CI lento a conferência podia
 * chegar depois disso. Parado, o resultado fica até `nextScan` avançar o tempo.
 */
export async function openScanner(page: Page, email: string, eventId: string) {
  await page.clock.install();
  await login(page, email, `/check-in/${eventId}`);
  await page.clock.pauseAt(await page.evaluate(() => Date.now() + 1000));
}

/** Deixa o resultado atual sair da tela e libera o leitor para a próxima leitura. */
export async function nextScan(page: Page) {
  await page.clock.runFor(2600);
}

/** Marca os dois aceites do cadastro (termos de uso e política de privacidade, R10). */
export async function acceptSignupTerms(page: Page) {
  await page.getByRole("checkbox", { name: /termos de uso/ }).check();
  await page.getByRole("checkbox", { name: /política de privacidade/ }).check();
}

/** Cria uma conta nova, confirma o e-mail e abre o cadastro de organizador. */
export async function signUpForOrganizer(page: Page, email: string, name = "Pessoa Teste E2E") {
  await page.goto("/registrar?next=/organizador/cadastro");
  await page.getByLabel("Nome completo").fill(name);
  await page.getByLabel("E-mail", { exact: true }).fill(email);
  await page.getByLabel("Confirmar e-mail", { exact: true }).fill(email);
  await page.getByLabel("Senha", { exact: true }).fill("Cadastro#E2e2468");
  await page.getByLabel("Confirmar senha", { exact: true }).fill("Cadastro#E2e2468");
  await acceptSignupTerms(page);
  await page.getByRole("button", { name: "Criar conta" }).click();
  // Conta nova confirma o e-mail antes de seguir para o cadastro de organizador.
  await page.waitForURL(/\/confirmar-email/);
  await confirmEmail(page, email);
  await page.goto("/organizador/cadastro");
}

/** Título (h2) do passo atual do cadastro de organizador. */
export const APPLICATION_STEP_TITLES = {
  perfil: "Como você vai vender ingressos?",
  marca: "Como o público vai te conhecer",
  legal: "Para os repasses e as obrigações fiscais",
  contato: "Como a equipe e o público falam com você",
  revisao: "Confira antes de enviar",
} as const;

export async function expectApplicationStep(page: Page, step: keyof typeof APPLICATION_STEP_TITLES) {
  await expect(page.getByRole("heading", { level: 2, name: APPLICATION_STEP_TITLES[step] })).toBeVisible();
}

export async function continueApplication(page: Page) {
  await page.getByRole("button", { name: /^(Continuar|Voltar para a revisão)$/ }).click();
}

/** Percorre o cadastro de organizador em passos, envia e vai ao painel. */
export async function submitOrganizerApplication(
  page: Page,
  { name, legalType = "COMPANY", legalName = `${name} LTDA`, document = "11.222.333/0001-81" }: { name: string; legalType?: "COMPANY" | "INDIVIDUAL"; legalName?: string; document?: string },
) {
  await expectApplicationStep(page, "perfil");
  await page.getByText(legalType === "COMPANY" ? "Empresa (CNPJ)" : "Pessoa física (CPF)", { exact: true }).click();
  await continueApplication(page);
  await expectApplicationStep(page, "marca");
  await page.getByLabel("Nome público").fill(name);
  await continueApplication(page);
  await expectApplicationStep(page, "legal");
  await page.getByLabel(legalType === "COMPANY" ? "Razão social" : "Nome completo").fill(legalName);
  await page.getByLabel(legalType === "COMPANY" ? "CNPJ" : "CPF", { exact: true }).fill(document);
  await continueApplication(page);
  await expectApplicationStep(page, "contato");
  await continueApplication(page);
  await expectApplicationStep(page, "revisao");
  await page.getByRole("checkbox", { name: /Li e aceito os termos para organizadores/ }).check();
  await page.getByRole("button", { name: "Enviar para análise" }).click();
  await expect(page.getByRole("heading", { name: "Cadastro enviado para análise" })).toBeVisible();
  await page.getByRole("link", { name: "Ir para o painel" }).click();
  await page.waitForURL(/\/organizador$/);
}

/**
 * QR que a câmera da portaria leria agora na tela do titular: o dinâmico (EB2), assinado
 * com a chave do ingresso como o celular faz (mesma derivação de deriveTicketSigningKey).
 */
export async function qrPayloadFor(code: string) {
  const client = new pg.Client({ connectionString: process.env.DATABASE_URL });
  await client.connect();
  const { rows } = await client.query('SELECT code, "tokenVersion", "legacyValidationToken", "eventId" FROM "IssuedTicket" WHERE code = $1', [code]);
  await client.end();
  expect(rows[0], `ingresso ${code}`).toBeTruthy();
  return { payload: dynamicQrOf(rows[0]), staticPayload: `EB1:${rows[0].code}:${qrTokenOf(rows[0])}`, eventId: rows[0].eventId as string };
}

/** Mesmo cálculo de deriveTicketSigningKey + assinatura do celular (src/features/tickets/dynamic-qr.tsx). */
function dynamicQrOf(t: { code: string; tokenVersion: number }) {
  const secret = process.env.QR_TOKEN_SECRET || "dev-only-qr-token-secret-0123456789";
  const d = createHmac("sha256", secret).update(`eb-qr-key:${t.code}:${t.tokenVersion}:0`).digest();
  const ecdh = createECDH("prime256v1");
  ecdh.setPrivateKey(d);
  const pub = ecdh.getPublicKey();
  const key = createPrivateKey({ key: { kty: "EC", crv: "P-256", d: d.toString("base64url"), x: pub.subarray(1, 33).toString("base64url"), y: pub.subarray(33, 65).toString("base64url") }, format: "jwk" });
  const step = Math.floor(Date.now() / 30_000);
  const signature = sign("sha256", Buffer.from(`eb2:${t.code}:${step}`), { key, dsaEncoding: "ieee-p1363" }).toString("base64url");
  return `EB2:${t.code}:${step}:${signature}`;
}

/** Mesmo cálculo de `ticketQrToken` (src/server/services/tickets.ts), com a chave do app. */
function qrTokenOf(t: { code: string; tokenVersion: number; legacyValidationToken: string | null }) {
  if (t.tokenVersion === 0) return t.legacyValidationToken;
  const secret = process.env.QR_TOKEN_SECRET || "dev-only-qr-token-secret-0123456789";
  return createHmac("sha256", secret).update(`eb-qr:${t.code}:${t.tokenVersion}`).digest("base64url");
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

/** Link do e-mail mais recente (outbox do console da suíte isolada) para `template`. */
export async function emailLink(email: string, template: string, route: string) {
  const client = new pg.Client({ connectionString: process.env.DATABASE_URL });
  await client.connect();
  try {
    let link = "";
    await expect
      .poll(async () => {
        const { rows } = await client.query(
          'SELECT "providerMessageId" FROM "EmailOutbox" WHERE recipient=$1 AND template=$2 AND status=\'SENT\' ORDER BY "createdAt" DESC LIMIT 1',
          [email, template],
        );
        if (!rows[0]?.providerMessageId) return false;
        const filename =
          rows[0].providerMessageId.replace(/^console:/, "") + ".html";
        const html = await readFile(
          path.resolve(".data/outbox", filename),
          "utf8",
        );
        const match = html.match(
          new RegExp('href="([^\"]*' + route + '[^\"]*)"'),
        );
        link = match?.[1]?.replace(/&amp;/g, "&") ?? "";
        return !!link;
      })
      .toBe(true);
    return link;
  } finally {
    await client.end();
  }
}

/** Confirma o e-mail de uma conta recém-criada pelo link enviado (suíte isolada). */
export async function confirmEmail(page: Page, email: string) {
  const link = await emailLink(email, "EMAIL_VERIFICATION", "confirmar-email");
  // A página já costuma estar em /confirmar-email?next=…; o link só acrescenta #token=…,
  // o que seria uma troca de âncora e não carregaria a confirmação. Sai antes.
  await page.goto("about:blank");
  await page.goto(link);
  await page.getByRole("button", { name: "Confirmar meu e-mail", exact: true }).click();
  await expect(page.getByRole("status").filter({ hasText: "E-mail confirmado com sucesso." })).toBeVisible();
}

/**
 * Código TOTP (RFC 6238, SHA-1, 6 dígitos) do segredo base32 mostrado na tela de
 * ativação. `stepOffset` = 1 dá o código do próximo passo de 30 s (o servidor aceita
 * ±1 e recusa um passo já usado, então o login logo após a ativação usa o próximo).
 */
export function totpFor(secretBase32: string, stepOffset = 0) {
  const alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";
  let bits = 0;
  let value = 0;
  const bytes: number[] = [];
  for (const ch of secretBase32.replace(/\s/g, "").toUpperCase()) {
    value = (value << 5) | alphabet.indexOf(ch);
    bits += 5;
    if (bits >= 8) {
      bytes.push((value >>> (bits - 8)) & 255);
      bits -= 8;
    }
  }
  const counter = Buffer.alloc(8);
  counter.writeBigUInt64BE(BigInt(Math.floor(Date.now() / 30_000) + stepOffset));
  const mac = createHmac("sha1", Buffer.from(bytes)).update(counter).digest();
  const offset = mac[mac.length - 1] & 0x0f;
  return ((mac.readUInt32BE(offset) & 0x7fffffff) % 1_000_000).toString().padStart(6, "0");
}
