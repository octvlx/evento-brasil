import { expect, test, type Page } from "@playwright/test";
import { acceptSignupTerms, login, USERS } from "./helpers";

/** Envia o convite pela tela de equipe e devolve o caminho /convite/… exibido. */
async function invite(page: Page, email: string, role: string) {
  await page.getByLabel("E-mail", { exact: true }).fill(email);
  await page.locator("#inv-role").selectOption(role);
  await page.getByRole("button", { name: "Convidar" }).click();
  const alert = page.getByText("Convite enviado por e-mail.");
  await expect(alert).toBeVisible();
  return linkPath(await alert.innerText());
}

function linkPath(text: string) {
  const path = text.match(/\/convite\/[A-Za-z0-9_-]+/)?.[0];
  expect(path, text).toBeTruthy();
  return path!;
}

test("organizador reenvia, revoga e altera papel; convidado aceita e recusa", async ({ page, browser }) => {
  const stamp = Date.now();
  const memberEmail = `equipe-e2e+${stamp}@test.local`;
  const decoyEmail = `revogar-e2e+${stamp}@test.local`;

  // Conta do futuro membro.
  const memberCtx = await browser.newContext();
  const member = await memberCtx.newPage();
  await member.goto("/registrar?next=/");
  await member.getByLabel("Nome completo").fill("Membro E2E");
  await member.getByLabel("E-mail", { exact: true }).fill(memberEmail);
  await member.getByLabel("Senha", { exact: true }).fill("senha-segura-e2e");
  await acceptSignupTerms(member);
  await member.getByRole("button", { name: "Criar conta" }).click();
  await member.waitForURL((url) => !url.pathname.startsWith("/registrar"));

  await login(page, USERS.producer, "/organizador/configuracoes");
  await expect(page.getByRole("heading", { name: "Equipe", exact: true })).toHaveCount(0);
  await page.getByRole("link", { name: "Equipe", exact: true }).click();
  await expect(page).toHaveURL(/\/organizador\/equipe$/);
  await expect(page.getByRole("heading", { name: "Equipe", exact: true })).toBeVisible();
  const menu = page.getByRole("link", { name: "Equipe", exact: true }).locator("..");
  const links = await menu.getByRole("link").allTextContents();
  expect(links.indexOf("Equipe")).toBe(links.indexOf("Eventos") + 1);

  // Convite → reenviar troca o link.
  const firstLink = await invite(page, memberEmail, "FINANCE");
  const memberInvite = page.getByTestId("pending-invitation").filter({ hasText: memberEmail });
  await expect(memberInvite).toBeVisible();
  await memberInvite.getByRole("button", { name: "Reenviar" }).click();
  const resent = memberInvite.getByText("Novo link");
  await expect(resent).toBeVisible();
  const secondLink = linkPath(await resent.innerText());
  expect(secondLink).not.toBe(firstLink);

  // Revogar some com o convite da lista.
  await invite(page, decoyEmail, "CHECKIN_STAFF");
  const decoy = page.getByTestId("pending-invitation").filter({ hasText: decoyEmail });
  await decoy.getByRole("button", { name: "Revogar" }).click();
  await expect(decoy).toHaveCount(0);

  // O link antigo não vale; o novo mostra o convite e é aceito.
  await member.goto(firstLink);
  await expect(member.getByText("Este convite é inválido")).toBeVisible();
  await member.goto(secondLink);
  await expect(member.getByText("Sonora Produções (demo)")).toBeVisible();
  await member.getByRole("button", { name: "Aceitar convite" }).click();
  await member.waitForURL(/\/check-in/);

  // Alterar o papel do novo membro persiste.
  await page.reload();
  await expect(page.getByTestId("pending-invitation").filter({ hasText: memberEmail })).toHaveCount(0);
  const row = page.getByTestId("team-member").filter({ hasText: memberEmail });
  await expect(row.getByLabel("Papel")).toHaveValue("FINANCE");
  await row.getByLabel("Papel").selectOption("EVENT_MANAGER");
  await expect(row.getByLabel("Papel")).toBeEnabled();
  await page.reload();
  await expect(page.getByTestId("team-member").filter({ hasText: memberEmail }).getByLabel("Papel")).toHaveValue("EVENT_MANAGER");

  // Convidado recusa um novo convite.
  const declineLink = await invite(page, memberEmail, "ADMIN");
  await member.goto(declineLink);
  await member.getByRole("button", { name: "Recusar convite" }).click();
  await expect(member.getByText("Convite recusado.")).toBeVisible();
  await page.reload();
  await expect(page.getByTestId("pending-invitation").filter({ hasText: memberEmail })).toHaveCount(0);

  await memberCtx.close();
});
