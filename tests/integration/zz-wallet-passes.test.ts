// Carteiras: passes registrados por versão do QR, sincronização pelo cron (Google:
// estado do objeto; Apple: push + passe anulado pelo web service) e o web service da Apple.
import { generateKeyPairSync } from "node:crypto";
import { beforeEach, describe, expect, it } from "vitest";
import { checkInTicket } from "@/server/services/checkin";
import { loadPdfTickets } from "@/server/services/notifications";
import { acceptTransfer, requestTransfer } from "@/server/services/transfers";
import { toWalletTickets } from "@/server/tickets/wallet";
import type { ApplePushSender } from "@/server/tickets/wallet/apple-push";
import {
  appleAuthToken,
  applePassBundleForTickets,
  applePassForTicket,
  applePassesUpdatedSince,
  authorizedApplePass,
  currentApplePass,
  desiredWalletState,
  recordGoogleWalletPasses,
  registerAppleDevice,
  syncWalletPasses,
  unregisterAppleDevice,
  WALLET_SYNC_MAX_ATTEMPTS,
} from "@/server/tickets/wallet/passes";
import { buyAndPay, db, gateQr, makeEvent, makeOrg, makeVerifiedUser as makeUser, resetDb } from "../support/fixtures";
import { TEST_SIGNER_CERT, TEST_SIGNER_KEY, TEST_WWDR_CERT } from "../support/wallet-test-certs";

// Apple ligada e site em HTTPS (web service de atualização), só neste arquivo.
const PASS_TYPE = "pass.br.eventobrasil.teste";
Object.assign(process.env, {
  APP_URL: "https://eventobrasil.example",
  APPLE_WALLET_PASS_TYPE_ID: PASS_TYPE,
  APPLE_WALLET_TEAM_ID: "TEAM123456",
  APPLE_WALLET_SIGNER_CERT: TEST_SIGNER_CERT,
  APPLE_WALLET_SIGNER_KEY: TEST_SIGNER_KEY,
  APPLE_WALLET_WWDR_CERT: TEST_WWDR_CERT,
});
const apple = { passTypeIdentifier: PASS_TYPE, teamIdentifier: "TEAM123456", signerCert: TEST_SIGNER_CERT, signerKey: TEST_SIGNER_KEY, wwdr: TEST_WWDR_CERT };
const google = {
  issuerId: "3388000000012345678",
  serviceAccountEmail: "wallet@projeto.iam.gserviceaccount.com",
  privateKey: generateKeyPairSync("rsa", { modulusLength: 2048, privateKeyEncoding: { type: "pkcs8", format: "pem" }, publicKeyEncoding: { type: "spki", format: "pem" } }).privateKey,
};

beforeEach(resetDb);

/** API do Google simulada: registra os PATCH de estado. */
function fakeGoogle(status = 200) {
  const patches: { id: string; state: string }[] = [];
  const fetchImpl = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);
    if (url.includes("oauth2")) return Response.json({ access_token: "tok" });
    if (init?.method === "PATCH") {
      if (status !== 200) return new Response("erro", { status });
      patches.push({ id: decodeURIComponent(url.split("/").pop()!), state: JSON.parse(String(init.body)).state });
      return Response.json({});
    }
    return Response.json(JSON.parse(String(init?.body ?? "{}")));
  }) as typeof fetch;
  return { patches, fetchImpl };
}

/** APNs simulado: tokens em `gone` respondem 410. */
function fakePush(gone: string[] = []) {
  const sent: string[][] = [];
  const push: ApplePushSender = async (_cfg, tokens) => {
    sent.push(tokens);
    return { sent: tokens.filter((t) => !gone.includes(t)), gone: tokens.filter((t) => gone.includes(t)), failed: [] };
  };
  return { sent, push };
}

async function setup(quantity = 2) {
  const owner = await makeUser();
  const org = await makeOrg(owner);
  const event = await makeEvent(org);
  const buyer = await makeUser();
  const { order } = await buyAndPay(buyer, event.id, [{ ticketTypeId: event.ticketTypes[0].id, quantity }]);
  const wallet = await toWalletTickets(db, await loadPdfTickets(db, { orderId: order.id }));
  return { owner, event, buyer, order, wallet };
}

const passJson = (buf: Buffer) => JSON.parse(zipEntries(buf)["pass.json"].toString());

describe("passes registrados", () => {
  it("Apple e Google: um registro por ingresso e versão do QR, sem duplicar ao baixar de novo", async () => {
    const { wallet } = await setup();
    const buf = await applePassForTicket(db, wallet[0], apple);
    await applePassForTicket(db, wallet[0], apple);
    const json = passJson(buf);
    expect(json).toMatchObject({
      serialNumber: `${wallet[0].code}-v1`,
      webServiceURL: "https://eventobrasil.example/api/wallet/apple",
      authenticationToken: appleAuthToken(`${wallet[0].code}-v1`),
    });
    await recordGoogleWalletPasses(db, wallet, google);
    await recordGoogleWalletPasses(db, wallet, google);
    const rows = await db.walletPass.findMany({ orderBy: [{ provider: "asc" }, { serial: "asc" }] });
    expect(rows.map((r) => [r.provider, r.serial, r.syncedState])).toEqual([
      ["APPLE", `${wallet[0].code}-v1`, "ACTIVE"],
      ...[...wallet].sort((a, b) => a.code.localeCompare(b.code)).map((t) => ["GOOGLE", `${google.issuerId}.ingresso-${t.code}-v1`, "ACTIVE"]),
    ]);
  });

  it(".pkpasses do pedido leva um passe por ingresso e registra todos", async () => {
    const { wallet } = await setup(3);
    const bundle = await applePassBundleForTickets(db, wallet, apple);
    expect(Object.keys(zipEntries(bundle))).toHaveLength(3);
    expect(await db.walletPass.count({ where: { provider: "APPLE" } })).toBe(3);
  });

  it("ingresso usado ou cancelado não gera passe novo", async () => {
    const { owner, event, order, wallet } = await setup();
    await checkInTicket(db, owner, event.id, gateQr(wallet[0]));
    await db.issuedTicket.update({ where: { id: wallet[1].ticketId }, data: { status: "REVOKED" } });
    expect(await toWalletTickets(db, await loadPdfTickets(db, { orderId: order.id }))).toEqual([]);
  });
});

describe("estado desejado", () => {
  it("válido → ACTIVE; usado → COMPLETED; cancelado ou outra versão do QR → INACTIVE", () => {
    expect(desiredWalletState({ status: "VALID", tokenVersion: 1 }, 1)).toBe("ACTIVE");
    expect(desiredWalletState({ status: "CHECKED_IN", tokenVersion: 1 }, 1)).toBe("COMPLETED");
    expect(desiredWalletState({ status: "REVOKED", tokenVersion: 1 }, 1)).toBe("INACTIVE");
    expect(desiredWalletState({ status: "VALID", tokenVersion: 2 }, 1)).toBe("INACTIVE");
  });
});

describe("sincronização (cron)", () => {
  it("Google: uso → COMPLETED, reembolso → INACTIVE, restauração → ACTIVE; sem mudança, nada é chamado", async () => {
    const { owner, event, wallet } = await setup();
    await recordGoogleWalletPasses(db, wallet, google);
    const g = fakeGoogle();
    const deps = { apple: null, google, fetchImpl: g.fetchImpl, push: fakePush().push };
    expect(await syncWalletPasses(db, deps)).toMatchObject({ google: 0 });

    await checkInTicket(db, owner, event.id, gateQr(wallet[0]));
    await db.issuedTicket.update({ where: { id: wallet[1].ticketId }, data: { status: "REVOKED" } });
    expect(await syncWalletPasses(db, deps)).toMatchObject({ google: 2, failed: 0 });
    expect(g.patches.sort((a, b) => a.state.localeCompare(b.state))).toEqual([
      { id: `${google.issuerId}.ingresso-${wallet[0].code}-v1`, state: "COMPLETED" },
      { id: `${google.issuerId}.ingresso-${wallet[1].code}-v1`, state: "INACTIVE" },
    ]);
    expect(await syncWalletPasses(db, deps)).toMatchObject({ google: 0 });

    // Reembolso desfeito pelo admin: o passe volta a valer.
    await db.issuedTicket.update({ where: { id: wallet[1].ticketId }, data: { status: "VALID" } });
    await syncWalletPasses(db, deps);
    expect(g.patches.at(-1)).toEqual({ id: `${google.issuerId}.ingresso-${wallet[1].code}-v1`, state: "ACTIVE" });
  });

  it("transferência: o passe do QR antigo vira INACTIVE e o do novo titular fica ACTIVE", async () => {
    const { buyer, wallet } = await setup(1);
    await recordGoogleWalletPasses(db, wallet, google);
    await applePassForTicket(db, wallet[0], apple);
    const recipient = await makeUser();
    const { token } = await requestTransfer(db, buyer, wallet[0].ticketId, { toEmail: recipient.email, toName: "Nova Titular" }, { ip: "203.0.113.9", userAgent: "vitest" });
    await acceptTransfer(db, recipient, token, { ip: "198.51.100.1", userAgent: "vitest" });
    const [moved] = await toWalletTickets(db, await loadPdfTickets(db, { code: wallet[0].code }));
    expect(moved.tokenVersion).toBe(2);
    await recordGoogleWalletPasses(db, [moved], google);

    const g = fakeGoogle();
    await syncWalletPasses(db, { apple, google, fetchImpl: g.fetchImpl, push: fakePush().push });
    expect(g.patches).toEqual([{ id: `${google.issuerId}.ingresso-${wallet[0].code}-v1`, state: "INACTIVE" }]);
    const states = await db.walletPass.findMany({ select: { provider: true, serial: true, syncedState: true }, orderBy: { serial: "asc" } });
    expect(states).toEqual(
      expect.arrayContaining([
        { provider: "APPLE", serial: `${wallet[0].code}-v1`, syncedState: "INACTIVE" },
        { provider: "GOOGLE", serial: `${google.issuerId}.ingresso-${wallet[0].code}-v1`, syncedState: "INACTIVE" },
        { provider: "GOOGLE", serial: `${google.issuerId}.ingresso-${wallet[0].code}-v2`, syncedState: "ACTIVE" },
      ]),
    );
  });

  it("Apple: avisa os aparelhos registrados e apaga o registro de token que não vale mais (410)", async () => {
    const { wallet } = await setup(1);
    await applePassForTicket(db, wallet[0], apple);
    const pass = await db.walletPass.findFirstOrThrow({ where: { provider: "APPLE" } });
    await registerAppleDevice(db, pass, "device-a", "aaaa1111");
    await registerAppleDevice(db, pass, "device-b", "bbbb2222");
    await db.issuedTicket.update({ where: { id: wallet[0].ticketId }, data: { status: "REVOKED" } });

    const p = fakePush(["bbbb2222"]);
    expect(await syncWalletPasses(db, { apple, google: null, fetchImpl: fakeGoogle().fetchImpl, push: p.push })).toMatchObject({ apple: 1, pushes: 1 });
    expect(p.sent).toEqual([expect.arrayContaining(["aaaa1111", "bbbb2222"])]);
    expect((await db.appleWalletRegistration.findMany()).map((r) => r.deviceLibraryId)).toEqual(["device-a"]);
    expect((await db.walletPass.findUniqueOrThrow({ where: { id: pass.id } })).syncedState).toBe("INACTIVE");
  });

  it("falha na API do Google: conta tentativas, guarda o erro e desiste depois do limite", async () => {
    const { wallet } = await setup(1);
    await recordGoogleWalletPasses(db, wallet, google);
    await db.issuedTicket.update({ where: { id: wallet[0].ticketId }, data: { status: "REVOKED" } });
    const deps = { apple: null, google, fetchImpl: fakeGoogle(500).fetchImpl, push: fakePush().push };
    expect(await syncWalletPasses(db, deps)).toMatchObject({ failed: 1 });
    const failed = await db.walletPass.findFirstOrThrow();
    expect(failed).toMatchObject({ syncedState: "ACTIVE", syncAttempts: 1 });
    expect(failed.syncError).toMatch(/500/);
    await db.walletPass.update({ where: { id: failed.id }, data: { syncAttempts: WALLET_SYNC_MAX_ATTEMPTS } });
    expect(await syncWalletPasses(db, deps)).toMatchObject({ failed: 0, google: 0 });
  });

  it("Google desligado: o passe espera (não é marcado como sincronizado)", async () => {
    const { wallet } = await setup(1);
    await recordGoogleWalletPasses(db, wallet, google);
    await db.issuedTicket.update({ where: { id: wallet[0].ticketId }, data: { status: "REVOKED" } });
    expect(await syncWalletPasses(db, { apple: null, google: null, fetchImpl: fakeGoogle().fetchImpl, push: fakePush().push })).toMatchObject({ skipped: 1 });
    expect((await db.walletPass.findFirstOrThrow()).syncedState).toBe("ACTIVE");
  });
});

describe("web service da Apple", () => {
  it("autenticação: token do próprio passe e Pass Type ID configurado", async () => {
    const { wallet } = await setup(1);
    await applePassForTicket(db, wallet[0], apple);
    const serial = `${wallet[0].code}-v1`;
    expect(await authorizedApplePass(db, PASS_TYPE, serial, `ApplePass ${appleAuthToken(serial)}`)).toMatchObject({ serial });
    expect(await authorizedApplePass(db, PASS_TYPE, serial, `ApplePass ${appleAuthToken("outro-v1")}`)).toBeNull();
    expect(await authorizedApplePass(db, PASS_TYPE, serial, null)).toBeNull();
    expect(await authorizedApplePass(db, "pass.outro", serial, `ApplePass ${appleAuthToken(serial)}`)).toBeNull();
  });

  it("registro, lista de alterados desde a marca e cancelamento do registro", async () => {
    const { wallet } = await setup(2);
    for (const t of wallet) await applePassForTicket(db, t, apple);
    const [p1, p2] = await db.walletPass.findMany({ orderBy: { serial: "asc" } });
    expect(await registerAppleDevice(db, p1, "device-a", "aaaa1111")).toBe("created");
    expect(await registerAppleDevice(db, p1, "device-a", "cccc3333")).toBe("exists");
    expect((await db.appleWalletRegistration.findFirstOrThrow()).pushToken).toBe("cccc3333");
    expect(await registerAppleDevice(db, p2, "device-a", "não é token")).toBe("invalid");
    await registerAppleDevice(db, p2, "device-a", "cccc3333");

    const first = await applePassesUpdatedSince(db, "device-a", PASS_TYPE, null);
    expect(first?.serialNumbers.sort()).toEqual([p1.serial, p2.serial].sort());
    expect(await applePassesUpdatedSince(db, "device-a", PASS_TYPE, first!.lastUpdated)).toBeNull();

    const ticketOfP1 = wallet.find((t) => p1.serial.startsWith(t.code))!;
    await db.issuedTicket.update({ where: { id: ticketOfP1.ticketId }, data: { status: "REVOKED" } });
    await syncWalletPasses(db, { apple, google: null, fetchImpl: fakeGoogle().fetchImpl, push: fakePush().push }, new Date(Date.now() + 1000));
    expect((await applePassesUpdatedSince(db, "device-a", PASS_TYPE, first!.lastUpdated))?.serialNumbers).toEqual([p1.serial]);
    expect(await applePassesUpdatedSince(db, "device-b", PASS_TYPE, null)).toBeNull();

    await unregisterAppleDevice(db, p1, "device-a");
    expect(await db.appleWalletRegistration.count({ where: { passId: p1.id } })).toBe(0);
  });

  it("passe atual: válido (comprovante, sem QR); reembolsado ou transferido, anulado e sem o novo titular", async () => {
    const { buyer, wallet } = await setup(1);
    await applePassForTicket(db, wallet[0], apple);
    const pass = await db.walletPass.findFirstOrThrow();
    const live = passJson(await currentApplePass(db, pass, apple));
    expect(live).not.toHaveProperty("barcodes");
    expect(live).not.toHaveProperty("voided");

    const recipient = await makeUser();
    const { token } = await requestTransfer(db, buyer, wallet[0].ticketId, { toEmail: recipient.email, toName: "Nova Titular" }, { ip: "203.0.113.9", userAgent: "vitest" });
    await acceptTransfer(db, recipient, token, { ip: "198.51.100.1", userAgent: "vitest" });
    const old = passJson(await currentApplePass(db, pass, apple));
    expect(old).toMatchObject({ voided: true, serialNumber: pass.serial });
    expect(old).not.toHaveProperty("barcodes");
    expect(JSON.stringify(old)).not.toContain("Nova Titular");
  });
});

/** Lê um zip sem compressão (.pkpass e .pkpasses) pelo diretório central. */
function zipEntries(buf: Buffer): Record<string, Buffer> {
  const eocd = buf.lastIndexOf(Buffer.from([0x50, 0x4b, 0x05, 0x06]));
  const count = buf.readUInt16LE(eocd + 10);
  let p = buf.readUInt32LE(eocd + 16);
  const out: Record<string, Buffer> = {};
  for (let i = 0; i < count; i++) {
    const size = buf.readUInt32LE(p + 20);
    const nameLen = buf.readUInt16LE(p + 28);
    const extraLen = buf.readUInt16LE(p + 30);
    const commentLen = buf.readUInt16LE(p + 32);
    const local = buf.readUInt32LE(p + 42);
    const name = buf.subarray(p + 46, p + 46 + nameLen).toString();
    const dataStart = local + 30 + buf.readUInt16LE(local + 26) + buf.readUInt16LE(local + 28);
    out[name] = buf.subarray(dataStart, dataStart + size);
    p += 46 + nameLen + extraLen + commentLen;
  }
  return out;
}
