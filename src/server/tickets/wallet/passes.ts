// Passes entregues às carteiras e a atualização deles.
//
// Cada passe (WalletPass) é de uma versão do QR do ingresso. O estado desejado vem do
// ingresso: VALID na mesma versão → ACTIVE; CHECKED_IN → COMPLETED; REVOKED
// (reembolso, cancelamento) ou versão substituída (transferência) → INACTIVE. O cron
// (syncWalletPasses) leva à carteira o que mudou:
// - Google: muda o estado do objeto pela API.
// - Apple: marca o passe como alterado e manda um push aos aparelhos registrados, que
//   pedem ao web service (rotas /api/wallet/apple/v1/...) o passe novo, anulado e sem QR.
// A portaria continua validando online: a carteira é só o reflexo para o comprador.
import "server-only";
import { createHmac } from "node:crypto";
import type { IssuedTicket, WalletPass, WalletPassState, WalletProvider } from "@/generated/prisma/client";
import type { Db } from "../../db";
import { env } from "../../env";
import { safeEqual } from "../../crypto";
import { PDF_TICKET_INCLUDE, toPdfTicket } from "../../services/notifications";
import { ticketQrToken } from "../../services/tickets";
import { appleSerial, buildApplePass, buildApplePassBundle } from "./apple";
import { sendApplePassPushes, type ApplePushSender } from "./apple-push";
import type { AppleWalletConfig, GoogleWalletConfig } from "./config";
import { appleWalletConfig, googleWalletConfig } from "./config";
import { googleObjectId, setGoogleObjectState } from "./google";
import type { WalletTicket } from "./types";

/** Estado que o passe de uma versão do QR deve mostrar, pelo ingresso atual. */
export function desiredWalletState(ticket: Pick<IssuedTicket, "status" | "tokenVersion">, passTokenVersion: number): WalletPassState {
  if (ticket.tokenVersion !== passTokenVersion || ticket.status === "REVOKED") return "INACTIVE";
  return ticket.status === "CHECKED_IN" ? "COMPLETED" : "ACTIVE";
}

/** Token que o aparelho Apple apresenta ao web service ("ApplePass <token>"): derivado, sem guardar. */
export function appleAuthToken(serial: string): string {
  return createHmac("sha256", env().AUTH_SECRET).update(`wallet-apple:${serial}`).digest("base64url");
}

/** URL do web service da Apple. A Apple só aceita HTTPS: em HTTP o passe sai sem atualização. */
export function appleWebServiceUrl(): string | null {
  const url = new URL(env().APP_URL);
  return url.protocol === "https:" ? `${url.origin}/api/wallet/apple` : null;
}

async function recordPasses(db: Db, provider: WalletProvider, entries: { ticketId: string; serial: string; tokenVersion: number }[]) {
  if (entries.length) await db.walletPass.createMany({ data: entries.map((e) => ({ ...e, provider })), skipDuplicates: true });
}

/** Registra os objetos do Google gravados para o link de salvar (um por ingresso e versão do QR). */
export async function recordGoogleWalletPasses(db: Db, tickets: WalletTicket[], cfg: GoogleWalletConfig) {
  await recordPasses(
    db,
    "GOOGLE",
    tickets.map((t) => ({ ticketId: t.ticketId, serial: googleObjectId(cfg, t.code, t.tokenVersion), tokenVersion: t.tokenVersion })),
  );
}

function appleOptions(serial: string) {
  const url = appleWebServiceUrl();
  return url ? { webService: { url, authenticationToken: appleAuthToken(serial) } } : {};
}

/** .pkpass de um ingresso válido (download e anexo do e-mail), registrado para receber atualizações. */
export async function applePassForTicket(db: Db, t: WalletTicket, cfg: AppleWalletConfig): Promise<Buffer> {
  const serial = appleSerial(t.code, t.tokenVersion);
  await recordPasses(db, "APPLE", [{ ticketId: t.ticketId, serial, tokenVersion: t.tokenVersion }]);
  return buildApplePass(t, cfg, appleOptions(serial));
}

/** .pkpasses com os ingressos (página do pedido), cada passe registrado para receber atualizações. */
export async function applePassBundleForTickets(db: Db, tickets: WalletTicket[], cfg: AppleWalletConfig): Promise<Buffer> {
  const items = tickets.map((t) => ({ ticket: t, serial: appleSerial(t.code, t.tokenVersion) }));
  await recordPasses(db, "APPLE", items.map((i) => ({ ticketId: i.ticket.ticketId, serial: i.serial, tokenVersion: i.ticket.tokenVersion })));
  return buildApplePassBundle(items.map((i) => ({ ticket: i.ticket, opts: appleOptions(i.serial) })), cfg);
}

// ───────────────────────────── Web service da Apple ─────────────────────────────

/** Passe pelo Pass Type ID e serial, se o cabeçalho "ApplePass <token>" confere. */
export async function authorizedApplePass(db: Db, passTypeId: string, serial: string, authorization: string | null): Promise<WalletPass | null> {
  const cfg = appleWalletConfig(env());
  if (!cfg || passTypeId !== cfg.passTypeIdentifier) return null;
  const token = /^ApplePass (.+)$/.exec(authorization ?? "")?.[1];
  if (!token || !safeEqual(token, appleAuthToken(serial))) return null;
  return db.walletPass.findUnique({ where: { provider_serial: { provider: "APPLE", serial } } });
}

const DEVICE_ID = /^[A-Za-z0-9._-]{1,128}$/;
const PUSH_TOKEN = /^[A-Za-z0-9]{1,200}$/;

/** Registra o aparelho para receber avisos deste passe. */
export async function registerAppleDevice(db: Db, pass: WalletPass, deviceLibraryId: string, pushToken: unknown): Promise<"created" | "exists" | "invalid"> {
  if (!DEVICE_ID.test(deviceLibraryId) || typeof pushToken !== "string" || !PUSH_TOKEN.test(pushToken)) return "invalid";
  const existing = await db.appleWalletRegistration.findUnique({ where: { deviceLibraryId_passId: { deviceLibraryId, passId: pass.id } } });
  if (existing) {
    if (existing.pushToken !== pushToken) await db.appleWalletRegistration.update({ where: { id: existing.id }, data: { pushToken } });
    return "exists";
  }
  await db.appleWalletRegistration.createMany({ data: [{ deviceLibraryId, passId: pass.id, pushToken }], skipDuplicates: true });
  return "created";
}

export async function unregisterAppleDevice(db: Db, pass: WalletPass, deviceLibraryId: string): Promise<void> {
  await db.appleWalletRegistration.deleteMany({ where: { deviceLibraryId, passId: pass.id } });
}

/**
 * Seriais dos passes do aparelho alterados depois de `since` (marca devolvida na
 * consulta anterior, em milissegundos). Nada alterado: null (resposta 204).
 */
export async function applePassesUpdatedSince(db: Db, deviceLibraryId: string, passTypeId: string, since: string | null) {
  const cfg = appleWalletConfig(env());
  if (!cfg || passTypeId !== cfg.passTypeIdentifier || !DEVICE_ID.test(deviceLibraryId)) return null;
  const sinceMs = since && /^\d{1,15}$/.test(since) ? Number(since) : null;
  const passes = await db.walletPass.findMany({
    where: { provider: "APPLE", registrations: { some: { deviceLibraryId } }, ...(sinceMs !== null ? { changedAt: { gt: new Date(sinceMs) } } : {}) },
    select: { serial: true, changedAt: true },
  });
  if (!passes.length) return null;
  const lastUpdated = Math.max(...passes.map((p) => p.changedAt.getTime()));
  return { serialNumbers: passes.map((p) => p.serial), lastUpdated: String(lastUpdated) };
}

/** O passe como está agora: anulado e sem QR se o ingresso não vale mais nesta versão. */
export async function currentApplePass(db: Db, pass: WalletPass, cfg: AppleWalletConfig): Promise<Buffer> {
  const row = await db.issuedTicket.findUniqueOrThrow({ where: { id: pass.ticketId }, include: { ...PDF_TICKET_INCLUDE, ticketType: { select: { name: true, kind: true } } } });
  const voided = desiredWalletState(row, pass.tokenVersion) !== "ACTIVE";
  const token = voided ? "" : (ticketQrToken(row) ?? "");
  const ticket: WalletTicket = {
    ...toPdfTicket(row, token),
    kind: row.ticketType.kind,
    eventId: row.eventId,
    ticketId: row.id,
    tokenVersion: pass.tokenVersion,
  };
  return buildApplePass(ticket, cfg, { ...appleOptions(pass.serial), voided: voided || !token, hideHolder: row.tokenVersion !== pass.tokenVersion });
}

// ───────────────────────────── Sincronização (cron) ─────────────────────────────

/** Passes por sincronização. */
const SYNC_BATCH = 200;
/** Depois disso o passe fica com o erro registrado e sai da fila. */
export const WALLET_SYNC_MAX_ATTEMPTS = 8;

export interface WalletSyncDeps {
  apple: AppleWalletConfig | null;
  google: GoogleWalletConfig | null;
  fetchImpl: typeof fetch;
  push: ApplePushSender;
}

const defaultDeps = (): WalletSyncDeps => ({ apple: appleWalletConfig(env()), google: googleWalletConfig(env()), fetchImpl: fetch, push: sendApplePassPushes });

/** Leva às carteiras os passes cujo estado mudou (reembolso, cancelamento, uso, transferência, restauração). */
export async function syncWalletPasses(db: Db, deps: WalletSyncDeps = defaultDeps(), now = new Date()) {
  const due = await db.$queryRaw<{ id: string; provider: WalletProvider; serial: string; desired: WalletPassState }[]>`
    SELECT p.id, p.provider, p.serial,
      CASE WHEN t."tokenVersion" <> p."tokenVersion" OR t.status = 'REVOKED' THEN 'INACTIVE'
           WHEN t.status = 'CHECKED_IN' THEN 'COMPLETED' ELSE 'ACTIVE' END AS desired
    FROM "WalletPass" p JOIN "IssuedTicket" t ON t.id = p."ticketId"
    WHERE p."syncAttempts" < ${WALLET_SYNC_MAX_ATTEMPTS}
      AND p."syncedState"::text <> CASE WHEN t."tokenVersion" <> p."tokenVersion" OR t.status = 'REVOKED' THEN 'INACTIVE'
           WHEN t.status = 'CHECKED_IN' THEN 'COMPLETED' ELSE 'ACTIVE' END
    ORDER BY p."createdAt"
    LIMIT ${SYNC_BATCH}`;
  const out = { google: 0, apple: 0, pushes: 0, failed: 0, skipped: 0 };
  for (const p of due) {
    try {
      if (p.provider === "GOOGLE") {
        if (!deps.google) {
          out.skipped++;
          continue;
        }
        await setGoogleObjectState(p.serial, p.desired, deps.google, deps.fetchImpl, now);
        await db.walletPass.update({ where: { id: p.id }, data: { syncedState: p.desired, changedAt: now, syncAttempts: 0, syncError: null } });
        out.google++;
        continue;
      }
      // Apple: o passe passa a ser servido no estado novo; o push só avisa o aparelho.
      await db.walletPass.update({ where: { id: p.id }, data: { syncedState: p.desired, changedAt: now, syncAttempts: 0, syncError: null } });
      out.apple++;
      if (!deps.apple) continue;
      const regs = await db.appleWalletRegistration.findMany({ where: { passId: p.id }, select: { id: true, pushToken: true } });
      if (!regs.length) continue;
      const res = await deps.push(deps.apple, [...new Set(regs.map((r) => r.pushToken))]);
      out.pushes += res.sent.length;
      if (res.gone.length) await db.appleWalletRegistration.deleteMany({ where: { passId: p.id, pushToken: { in: res.gone } } });
      // Aparelho sem aviso ainda vê o passe novo quando a carteira atualizar sozinha.
      if (res.failed.length) await db.walletPass.update({ where: { id: p.id }, data: { syncError: `push falhou para ${res.failed.length} aparelho(s)` } });
    } catch (err) {
      out.failed++;
      await db.walletPass.update({
        where: { id: p.id },
        data: { syncAttempts: { increment: 1 }, syncError: (err instanceof Error ? err.message : String(err)).slice(0, 500) },
      });
    }
  }
  return out;
}
