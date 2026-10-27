import { createHash, createVerify, generateKeyPairSync } from "node:crypto";
import { describe, expect, it } from "vitest";
import type { Env } from "@/server/env";
import { appleWalletConfig, googleWalletConfig, pemFromEnv } from "@/server/tickets/wallet/config";
import { applePassJson, buildApplePass } from "@/server/tickets/wallet/apple";
import { googleWalletJwtPayload, googleWalletSaveUrl } from "@/server/tickets/wallet/google";
import type { WalletTicket } from "@/server/tickets/wallet/types";
import { TEST_SIGNER_CERT, TEST_SIGNER_KEY, TEST_WWDR_CERT } from "../support/wallet-test-certs";

const ticket = (over: Partial<WalletTicket> = {}): WalletTicket => ({
  code: "ABCD1234EF",
  validationToken: "t".repeat(43),
  holderName: "Clara Cliente",
  ticketTypeName: "Inteira",
  kind: "GENERAL",
  orderCode: "EB-TESTE01",
  isSimulated: false,
  eventId: "cevento1",
  event: {
    title: "Noite de Samba",
    startsAt: new Date("2026-12-05T21:00:00Z"),
    endsAt: new Date("2026-12-06T03:00:00Z"),
    timezone: "America/Sao_Paulo",
    place: "Terraço Aurora, São Paulo – SP",
    organizer: "Sonora",
    ageRestriction: 0,
  },
  ...over,
});
const env = (vars: Partial<Env>) => vars as Env;

describe("configuração das carteiras", () => {
  it("cada carteira só liga com todas as variáveis", () => {
    expect(appleWalletConfig(env({}))).toBeNull();
    expect(appleWalletConfig(env({ APPLE_WALLET_PASS_TYPE_ID: "pass.x", APPLE_WALLET_TEAM_ID: "TEAM", APPLE_WALLET_SIGNER_CERT: "c", APPLE_WALLET_SIGNER_KEY: "k" }))).toBeNull();
    expect(googleWalletConfig(env({ GOOGLE_WALLET_ISSUER_ID: "123", GOOGLE_WALLET_SERVICE_ACCOUNT_EMAIL: "  " }))).toBeNull();
    expect(googleWalletConfig(env({ GOOGLE_WALLET_ISSUER_ID: "123", GOOGLE_WALLET_SERVICE_ACCOUNT_EMAIL: "sa@x.iam.gserviceaccount.com", GOOGLE_WALLET_PRIVATE_KEY: TEST_SIGNER_KEY }))).toMatchObject({ issuerId: "123" });
  });

  it("PEM aceito com \\n escapado ou em base64", () => {
    const pem = "-----BEGIN X-----\nabc\n-----END X-----";
    expect(pemFromEnv(pem.replace(/\n/g, "\\n"))).toBe(pem);
    expect(pemFromEnv(Buffer.from(pem).toString("base64"))).toBe(pem);
  });
});

describe("Google Wallet", () => {
  const { privateKey, publicKey } = generateKeyPairSync("rsa", { modulusLength: 2048, privateKeyEncoding: { type: "pkcs8", format: "pem" }, publicKeyEncoding: { type: "spki", format: "pem" } });
  const cfg = { issuerId: "3388000000012345678", serviceAccountEmail: "wallet@projeto.iam.gserviceaccount.com", privateKey };

  it("link de salvar com JWT RS256 válido, uma classe por evento e um objeto por ingresso", () => {
    const url = googleWalletSaveUrl([ticket(), ticket({ code: "ZZZZ9999ZZ", kind: "HALF_PRICE", ticketTypeName: "Meia" })], cfg, "https://eventobrasil.example");
    expect(url.startsWith("https://pay.google.com/gp/v/save/")).toBe(true);
    const [header, body, sig] = url.slice("https://pay.google.com/gp/v/save/".length).split(".");
    expect(createVerify("RSA-SHA256").update(`${header}.${body}`).verify(publicKey, Buffer.from(sig, "base64url"))).toBe(true);
    const payload = JSON.parse(Buffer.from(body, "base64url").toString());
    expect(payload).toMatchObject({ iss: cfg.serviceAccountEmail, aud: "google", typ: "savetowallet", origins: ["https://eventobrasil.example"] });
    expect(payload.payload.eventTicketClasses).toHaveLength(1);
    expect(payload.payload.eventTicketClasses[0].id).toBe(`${cfg.issuerId}.evento-cevento1`);
    const [a, b] = payload.payload.eventTicketObjects;
    expect(a).toMatchObject({ id: `${cfg.issuerId}.ingresso-ABCD1234EF`, state: "ACTIVE", barcode: { type: "QR_CODE", value: `EB1:ABCD1234EF:${"t".repeat(43)}` } });
    expect(b.ticketType.defaultValue.value).toMatch(/meia-entrada/);
  });

  it("ingresso de teste leva o aviso", () => {
    const payload = googleWalletJwtPayload([ticket({ isSimulated: true })], cfg, "http://localhost:3000");
    expect(JSON.stringify(payload)).toMatch(/Pagamento simulado/);
  });
});

describe("Apple Wallet", () => {
  const cfg = { passTypeIdentifier: "pass.br.eventobrasil.teste", teamIdentifier: "TEAM123456", signerCert: TEST_SIGNER_CERT, signerKey: TEST_SIGNER_KEY, wwdr: TEST_WWDR_CERT };

  it("pass.json de evento com QR, data relevante e avisos", () => {
    const json = applePassJson(ticket({ kind: "HALF_PRICE" }), cfg);
    expect(json).toMatchObject({ passTypeIdentifier: cfg.passTypeIdentifier, teamIdentifier: cfg.teamIdentifier, serialNumber: "ABCD1234EF", relevantDate: "2026-12-05T21:00:00.000Z" });
    expect(json.barcodes[0]).toMatchObject({ format: "PKBarcodeFormatQR", message: `EB1:ABCD1234EF:${"t".repeat(43)}` });
    expect(JSON.stringify(json.eventTicket.backFields)).toMatch(/documento comprobatório/);
  });

  it(".pkpass assinado: zip com pass.json, imagens, manifest (sha1) e assinatura", async () => {
    const buf = await buildApplePass(ticket(), cfg);
    expect(buf.subarray(0, 2).toString()).toBe("PK");
    const entries = zipEntries(buf);
    expect(Object.keys(entries).sort()).toEqual(
      ["icon.png", "icon@2x.png", "icon@3x.png", "logo.png", "logo@2x.png", "logo@3x.png", "manifest.json", "pass.json", "signature"].sort(),
    );
    const manifest = JSON.parse(entries["manifest.json"].toString());
    expect(manifest["pass.json"]).toBe(createHash("sha1").update(entries["pass.json"]).digest("hex"));
    expect(JSON.parse(entries["pass.json"].toString()).serialNumber).toBe("ABCD1234EF");
    expect(entries.signature.length).toBeGreaterThan(500);
  });
});

/** Lê um zip sem compressão (o do .pkpass) pelo diretório central. */
function zipEntries(buf: Buffer): Record<string, Buffer> {
  const eocd = buf.lastIndexOf(Buffer.from([0x50, 0x4b, 0x05, 0x06]));
  const count = buf.readUInt16LE(eocd + 10);
  let p = buf.readUInt32LE(eocd + 16);
  const out: Record<string, Buffer> = {};
  for (let i = 0; i < count; i++) {
    const method = buf.readUInt16LE(p + 10);
    const size = buf.readUInt32LE(p + 20);
    const nameLen = buf.readUInt16LE(p + 28);
    const extraLen = buf.readUInt16LE(p + 30);
    const commentLen = buf.readUInt16LE(p + 32);
    const local = buf.readUInt32LE(p + 42);
    const name = buf.subarray(p + 46, p + 46 + nameLen).toString();
    if (method !== 0) throw new Error(`entrada comprimida: ${name}`);
    const dataStart = local + 30 + buf.readUInt16LE(local + 26) + buf.readUInt16LE(local + 28);
    out[name] = buf.subarray(dataStart, dataStart + size);
    p += 46 + nameLen + extraLen + commentLen;
  }
  return out;
}
