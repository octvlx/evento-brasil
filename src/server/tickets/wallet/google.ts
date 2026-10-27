// Google Wallet: link "Salvar no Google Wallet" (https://pay.google.com/gp/v/save/<JWT>).
// O link tem limite de ~1800 caracteres, e a classe + o objeto completos de um único
// ingresso já passam disso. Por isso a classe do evento e os objetos dos ingressos são
// gravados antes pela API REST (insert; se já existem, update com os dados atuais) e o
// JWT só referencia os ids dos objetos. O QR é o mesmo do ingresso e do PDF
// (validação online na portaria).
import "server-only";
import { createSign } from "node:crypto";
import { qrPayload } from "../../services/tickets";
import type { GoogleWalletConfig } from "./config";
import type { WalletTicket } from "./types";

const SAVE_URL = "https://pay.google.com/gp/v/save/";
const TOKEN_URL = "https://oauth2.googleapis.com/token";
const API_URL = "https://walletobjects.googleapis.com/walletobjects/v1";
const SCOPE = "https://www.googleapis.com/auth/wallet_object.issuer";
const BRAND = "#312e81";

const b64url = (data: string | Buffer) => Buffer.from(data).toString("base64url");
const text = (value: string) => ({ defaultValue: { language: "pt-BR", value } });
// Ids do Google Wallet: "<issuerId>.<sufixo>", sufixo só com letras, números, ".", "_" e "-".
const suffix = (s: string) => s.replace(/[^A-Za-z0-9._-]/g, "_");

function signJwt(claims: object, privateKey: string): string {
  const header = b64url(JSON.stringify({ alg: "RS256", typ: "JWT" }));
  const body = b64url(JSON.stringify(claims));
  const signature = createSign("RSA-SHA256").update(`${header}.${body}`).sign(privateKey);
  return `${header}.${body}.${b64url(signature)}`;
}

type Resource = { id: string } & Record<string, unknown>;

/** Classes (uma por evento) e objetos (um por ingresso) gravados na API do Google Wallet. */
export function googleWalletResources(tickets: WalletTicket[], cfg: GoogleWalletConfig) {
  const classes = new Map<string, Resource>();
  const objects: Resource[] = tickets.map((t) => {
    const classId = `${cfg.issuerId}.evento-${suffix(t.eventId)}`;
    if (!classes.has(classId)) {
      classes.set(classId, {
        id: classId,
        issuerName: "Evento Brasil",
        reviewStatus: "UNDER_REVIEW",
        eventName: text(t.event.title),
        venue: { name: text(t.event.place || "Local a definir"), address: text(t.event.place || "Local a definir") },
        dateTime: { start: t.event.startsAt.toISOString(), end: t.event.endsAt.toISOString() },
        hexBackgroundColor: BRAND,
      });
    }
    return {
      id: `${cfg.issuerId}.ingresso-${suffix(t.code)}`,
      classId,
      state: "ACTIVE",
      ticketHolderName: t.holderName ?? undefined,
      ticketNumber: t.code,
      ticketType: text(t.kind === "HALF_PRICE" ? `${t.ticketTypeName} (meia-entrada: documento na entrada)` : t.ticketTypeName),
      barcode: { type: "QR_CODE", value: qrPayload(t), alternateText: t.code },
      hexBackgroundColor: BRAND,
      ...(t.isSimulated ? { textModulesData: [{ id: "teste", header: "Ingresso de teste", body: "Pagamento simulado: sem validade real." }] } : {}),
    };
  });
  return { classes: [...classes.values()], objects };
}

/** JWT curto do link: só os ids dos objetos já gravados pela API. */
export function googleWalletJwtPayload(objectIds: string[], cfg: GoogleWalletConfig, appUrl: string, now = new Date()) {
  return {
    iss: cfg.serviceAccountEmail,
    aud: "google",
    typ: "savetowallet",
    iat: Math.floor(now.getTime() / 1000),
    origins: [new URL(appUrl).origin],
    payload: { eventTicketObjects: objectIds.map((id) => ({ id })) },
  };
}

async function accessToken(cfg: GoogleWalletConfig, fetchImpl: typeof fetch, now: Date): Promise<string> {
  const iat = Math.floor(now.getTime() / 1000);
  const assertion = signJwt({ iss: cfg.serviceAccountEmail, scope: SCOPE, aud: TOKEN_URL, iat, exp: iat + 3600 }, cfg.privateKey);
  const res = await fetchImpl(TOKEN_URL, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer", assertion }),
  });
  if (!res.ok) throw new Error(`Google Wallet: token recusado (${res.status}) ${await res.text()}`);
  return ((await res.json()) as { access_token: string }).access_token;
}

/** Insere o recurso; se já existe (409), atualiza com os dados atuais (evento remarcado etc.). */
async function upsert(kind: "eventTicketClass" | "eventTicketObject", resource: Resource, token: string, fetchImpl: typeof fetch) {
  const headers = { authorization: `Bearer ${token}`, "content-type": "application/json" };
  const body = JSON.stringify(resource);
  let res = await fetchImpl(`${API_URL}/${kind}`, { method: "POST", headers, body });
  if (res.status === 409) res = await fetchImpl(`${API_URL}/${kind}/${encodeURIComponent(resource.id)}`, { method: "PUT", headers, body });
  if (!res.ok) throw new Error(`Google Wallet: falha ao gravar ${kind} ${resource.id} (${res.status}) ${await res.text()}`);
}

/** Grava classe e objetos na API e devolve a URL de "Salvar no Google Wallet" (JWT RS256 curto). */
export async function googleWalletSaveUrl(
  tickets: WalletTicket[],
  cfg: GoogleWalletConfig,
  appUrl: string,
  fetchImpl: typeof fetch = fetch,
  now = new Date(),
): Promise<string> {
  const { classes, objects } = googleWalletResources(tickets, cfg);
  const token = await accessToken(cfg, fetchImpl, now);
  // Classe antes dos objetos: o objeto referencia a classe pelo id.
  for (const c of classes) await upsert("eventTicketClass", c, token, fetchImpl);
  await Promise.all(objects.map((o) => upsert("eventTicketObject", o, token, fetchImpl)));
  return SAVE_URL + signJwt(googleWalletJwtPayload(objects.map((o) => o.id), cfg, appUrl, now), cfg.privateKey);
}
