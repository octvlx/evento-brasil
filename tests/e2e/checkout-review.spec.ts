import { readFile } from "node:fs/promises";
import path from "node:path";
import pg from "pg";
import { expect, test, type Page } from "@playwright/test";
import {
  acceptSignupTerms,
  createCouponLink,
  login,
  proceedThroughReview,
  USERS,
} from "./helpers";

const eventPath = "/eventos/festival-litoral-sonoro-rio-de-janeiro";
async function sql<T extends pg.QueryResultRow>(
  query: string,
  values: unknown[] = [],
) {
  const client = new pg.Client({ connectionString: process.env.DATABASE_URL });
  await client.connect();
  try {
    return (await client.query<T>(query, values)).rows;
  } finally {
    await client.end();
  }
}
async function startSelection(page: Page, quantity = 1) {
  await page.goto(eventPath);
  const ticket = page.locator("li").filter({ hasText: "Lote promocional" });
  for (let index = 0; index < quantity; index++)
    await ticket.getByRole("button", { name: "Aumentar" }).click();
}
async function confirmFromOutbox(page: Page, email: string) {
  const dir = path.resolve(".data/outbox");
  let link = "";
  await expect
    .poll(async () => {
      const deliveries = await sql<{ providerMessageId: string }>(
        `SELECT "providerMessageId" FROM "EmailOutbox" WHERE recipient=$1 AND template='EMAIL_VERIFICATION' AND status='SENT' ORDER BY "createdAt" DESC`,
        [email],
      );
      const files = deliveries.map(
        (job) => job.providerMessageId?.replace(/^console:/, "") + ".html",
      );
      for (const file of files) {
        const html = await readFile(path.join(dir, file), "utf8");
        const match = html.match(/href="([^"]*\/confirmar-email[^"]*)"/);
        if (match) {
          link = match[1].replace(/&amp;/g, "&");
          return true;
        }
      }
      return false;
    })
    .toBe(true);
  await page.goto(link);
  await page
    .getByRole("button", { name: "Confirmar meu e-mail", exact: true })
    .click();
  await expect(
    page
      .getByRole("status")
      .filter({ hasText: "E-mail confirmado com sucesso." }),
  ).toBeVisible();
  await page
    .getByRole("link", { name: "Voltar e continuar", exact: true })
    .click();
}

test("first purchase preserves anonymous cart, verifies email, collects identity/address, reviews and pays safely", async ({
  page,
}) => {
  test.skip(
    process.env.E2E_ISOLATED !== "1",
    "Disposable database and local email outbox required.",
  );
  const email = `checkout-review+${Date.now()}@test.local`;
  await startSelection(page, 2);
  await page.reload();
  await expect(page.getByText("Ingressos (2)", { exact: true })).toBeVisible();
  await page.getByRole("button", { name: "Continuar para revisão" }).click();
  await page.waitForURL(/\/entrar\?/);
  await page
    .getByRole("main")
    .getByRole("link", { name: "Criar conta", exact: true })
    .click();
  await page
    .getByLabel("Nome completo", { exact: true })
    .fill("Pessoa Revisão E2E");
  await page.getByLabel("E-mail", { exact: true }).fill(email);
  await page.getByLabel("Senha", { exact: true }).fill("Cadastro#E2e2468");
  await page.getByLabel("Confirmar senha", { exact: true }).fill("Cadastro#E2e2468");
  await acceptSignupTerms(page);
  await page.getByRole("button", { name: "Criar conta", exact: true }).click();
  await page.waitForURL(/\/confirmar-email/);
  await expect(
    page.getByRole("heading", { name: "Confirme seu e-mail", exact: true }),
  ).toBeVisible();
  expect(
    (
      await sql<{ count: number }>(
        'SELECT count(*)::int AS count FROM "Order" o JOIN "User" u ON u.id=o."userId" WHERE u.email=$1',
        [email],
      )
    )[0].count,
  ).toBe(0);
  await confirmFromOutbox(page, email);
  await page.getByLabel("CPF", { exact: true }).fill("168.995.350-09");
  await page
    .getByLabel("Data de nascimento", { exact: true })
    .fill("1995-04-15");
  await page
    .getByRole("button", { name: "Salvar dados e voltar à revisão" })
    .click();
  await page.getByLabel("CEP", { exact: true }).fill("01001-000");
  await page.getByLabel("Número", { exact: true }).focus();
  await expect(page.getByLabel("Rua", { exact: true })).toHaveValue(
    "Praça da Sé",
  );
  await page.getByLabel("Número", { exact: true }).fill("123");
  await page.getByLabel("Complemento (opcional)").fill("Apto 2");
  await page
    .getByRole("button", { name: "Salvar endereço e voltar à revisão" })
    .click();
  await page
    .getByRole("button", { name: "Revisar valores e ingressos" })
    .click();
  await expect(
    page.getByRole("button", {
      name: "Confirmar e ir para pagamento",
      exact: true,
    }),
  ).toBeEnabled();
  await expect(page.getByText("***.***.***-09", { exact: true })).toBeVisible();
  await expect(page.getByText("15/04/1995", { exact: true })).toBeVisible();
  await expect(page.locator("body")).not.toContainText("168.995.350-09");
  await page.screenshot({
    path: ".data/checkout-review-desktop.png",
    fullPage: true,
  });
  const viewport = page.viewportSize()!;
  await page.setViewportSize({ width: 390, height: 844 });
  await page.screenshot({
    path: ".data/checkout-review-mobile.png",
    fullPage: true,
  });
  await page.setViewportSize(viewport);
  const draftId = new URL(page.url()).pathname.split("/").pop()!;
  const before = (
    await sql<{ orderId: string; totalCents: number }>(
      'SELECT d."orderId", o."totalCents" FROM "CheckoutDraft" d JOIN "Order" o ON o.id=d."orderId" WHERE d.id=$1',
      [draftId],
    )
  )[0];
  await page.reload();
  expect(
    (
      await sql<{ orderId: string }>(
        'SELECT "orderId" FROM "CheckoutDraft" WHERE id=$1',
        [draftId],
      )
    )[0].orderId,
  ).toBe(before.orderId);
  await page.getByRole("button", { name: "Editar dados", exact: true }).click();
  await page
    .getByLabel("Nome completo", { exact: true })
    .fill("Pessoa Nome Corrigido");
  await expect(page.getByLabel("CPF", { exact: true })).toHaveCount(0);
  await page
    .getByRole("button", { name: "Salvar dados e voltar à revisão" })
    .click();
  await expect(
    page.getByText("Pessoa Nome Corrigido", { exact: true }),
  ).toBeVisible();
  await page
    .getByRole("button", { name: "Editar endereço", exact: true })
    .click();
  await page.getByLabel("CEP", { exact: true }).fill("01310-930");
  await page.getByLabel("Número", { exact: true }).focus();
  await expect(page.getByLabel("Rua", { exact: true })).toHaveValue(
    "Avenida Paulista",
  );
  await page.getByLabel("Número", { exact: true }).fill("456");
  await page.getByLabel("Complemento (opcional)").fill("");
  await page
    .getByRole("button", { name: "Salvar endereço e voltar à revisão" })
    .click();
  await page
    .getByRole("button", { name: "Atualizar valores e reserva" })
    .click();
  await expect(
    page.getByText("Avenida Paulista, 456", { exact: true }),
  ).toBeVisible();
  await proceedThroughReview(page);
  expect(new URL(page.url()).pathname).toBe(`/checkout/${before.orderId}`);
  await page.getByRole("button", { name: "Gerar PIX", exact: true }).click();
  await expect(page.getByText(/SIMULADO-NAO-PAGUE/)).toBeVisible();
  expect(
    (
      await sql<{ count: number }>(
        'SELECT count(*)::int AS count FROM "IssuedTicket" WHERE "orderId"=$1',
        [before.orderId],
      )
    )[0].count,
  ).toBe(0);
  await page.getByRole("button", { name: "Aprovar PIX", exact: true }).click();
  await page.waitForURL(/\/pedido\//);
  expect(
    (
      await sql<{ count: number }>(
        'SELECT count(*)::int AS count FROM "IssuedTicket" WHERE "orderId"=$1',
        [before.orderId],
      )
    )[0].count,
  ).toBe(2);
  await startSelection(page);
  await page.getByRole("button", { name: "Continuar para revisão" }).click();
  await page.waitForURL(/\/checkout\/revisao\//);
  await expect(
    page.getByText("Avenida Paulista, 456", { exact: true }),
  ).toBeVisible();
  await expect(page.getByLabel("CEP", { exact: true })).toHaveCount(0);
  await expect(
    page.getByRole("button", { name: "Revisar valores e ingressos" }),
  ).toBeEnabled();
  expect(
    (
      await sql<{ count: number }>(
        'SELECT count(*)::int AS count FROM "UserAddress" a JOIN "User" u ON u.id=a."userId" WHERE u.email=$1',
        [email],
      )
    )[0].count,
  ).toBe(1);
});

test("review supports manual address fallback when CEP is unavailable", async ({
  page,
}) => {
  test.skip(
    process.env.E2E_ISOLATED !== "1",
    "Isolated ViaCEP transport required.",
  );
  await login(page, "amiga@demo.eventobrasil.test", eventPath);
  await page
    .locator("li")
    .filter({ hasText: "Lote promocional" })
    .getByRole("button", { name: "Aumentar" })
    .click();
  await page.getByRole("button", { name: "Continuar para revisão" }).click();
  await page.waitForURL(/\/checkout\/revisao\//);
  await page
    .getByRole("button", { name: "Editar endereço", exact: true })
    .click();
  await page.getByLabel("CEP", { exact: true }).fill("99999-999");
  await page.getByLabel("Número", { exact: true }).focus();
  await expect(page.getByRole("status")).toContainText(
    "preencher o endereço manualmente",
  );
  await page.getByLabel("Rua", { exact: true }).fill("Rua Manual");
  await page.getByLabel("Número", { exact: true }).fill("22");
  await page
    .getByRole("button", { name: "Salvar endereço e voltar à revisão" })
    .click();
  await expect(page.getByText("Rua Manual, 22", { exact: true })).toBeVisible();
});

test("backend price change requires a second explicit confirmation without charging", async ({
  page,
}) => {
  test.skip(
    process.env.E2E_ISOLATED !== "1",
    "Only mutate disposable database fixtures.",
  );
  await login(page, USERS.customer, eventPath);
  await page
    .locator("li")
    .filter({ hasText: "Lote promocional" })
    .getByRole("button", { name: "Aumentar" })
    .click();
  await page.getByRole("button", { name: "Continuar para revisão" }).click();
  await page.waitForURL(/\/checkout\/revisao\//);
  await page
    .getByRole("button", { name: "Revisar valores e ingressos" })
    .click();
  const draftId = new URL(page.url()).pathname.split("/").pop()!;
  const original = (
    await sql<{ id: string; priceCents: number }>(
      'SELECT t.id,t."priceCents" FROM "TicketType" t JOIN "CheckoutDraft" d ON d."eventId"=t."eventId" WHERE d.id=$1 AND t.name=$2',
      [draftId, "Lote promocional"],
    )
  )[0];
  try {
    await sql(
      'UPDATE "TicketType" SET "priceCents"="priceCents"+1000 WHERE id=$1',
      [original.id],
    );
    await page
      .getByRole("button", { name: "Confirmar e ir para pagamento" })
      .click();
    await expect(
      page.getByText(
        "Os dados, valores ou a disponibilidade foram atualizados. Confira o novo resumo e confirme novamente.",
      ),
    ).toBeVisible();
    await expect(page).toHaveURL(/\/checkout\/revisao\//);
    expect(
      (
        await sql<{ count: number }>(
          'SELECT count(*)::int AS count FROM "Payment" p JOIN "CheckoutDraft" d ON d."orderId"=p."orderId" WHERE d.id=$1',
          [draftId],
        )
      )[0].count,
    ).toBe(0);
    await page
      .getByRole("button", { name: "Confirmar e ir para pagamento" })
      .click();
    await page.waitForURL(/\/checkout\/(?!revisao\/)/);
  } finally {
    await sql('UPDATE "TicketType" SET "priceCents"=$2 WHERE id=$1', [
      original.id,
      original.priceCents,
    ]);
  }
});

test("accepted quantity and coupon edits survive returning to the event and refreshing", async ({
  page,
}) => {
  test.skip(
    process.env.E2E_ISOLATED !== "1",
    "Disposable coupon fixtures required.",
  );
  const { couponCode } = await createCouponLink(
    "festival-litoral-sonoro-rio-de-janeiro",
  );
  await login(page, USERS.customer, eventPath);
  await page
    .locator("li")
    .filter({ hasText: "Lote promocional" })
    .getByRole("button", { name: "Aumentar" })
    .click();
  await page.getByRole("button", { name: "Continuar para revisão" }).click();
  await page.waitForURL(/\/checkout\/revisao\//);
  await page
    .getByRole("button", { name: "Alterar ingressos", exact: true })
    .click();
  await page.getByLabel("Lote promocional", { exact: true }).fill("2");
  await page
    .getByLabel("Cupom de desconto", { exact: true })
    .filter({ visible: true })
    .fill(couponCode);
  await page
    .getByRole("button", { name: "Salvar ingressos e voltar à revisão" })
    .click();
  await expect(
    page.getByText("2× Lote promocional", { exact: true }),
  ).toBeVisible();
  await page
    .getByRole("link", { name: "Voltar ao evento", exact: true })
    .click();
  await page.waitForURL((url) => url.pathname === eventPath);
  await page.reload();
  await expect(page.getByText("Ingressos (2)", { exact: true })).toBeVisible();
  await page
    .getByRole("button", { name: "Tenho um cupom de desconto", exact: true })
    .click();
  const coupon = page
    .getByLabel("Cupom de desconto", { exact: true })
    .filter({ visible: true });
  await expect(coupon).toHaveValue(couponCode);
  await coupon.fill("NAOEXISTE");
  await page.getByRole("button", { name: "Continuar para revisão" }).click();
  await page.waitForURL(/\/checkout\/revisao\//);
  const draftId = new URL(page.url()).pathname.split("/").pop()!;
  const draft = (
    await sql<{ selection: { couponCode: string } }>(
      'SELECT selection FROM "CheckoutDraft" WHERE id=$1',
      [draftId],
    )
  )[0];
  expect(draft.selection.couponCode).toBe("NAOEXISTE");
});
