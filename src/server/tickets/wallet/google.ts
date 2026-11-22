// Google Wallet: link "Salvar no Google Wallet" (https://pay.google.com/gp/v/save/<JWT>).
// O link tem limite de ~1800 caracteres, e a classe + o objeto completos de um único
// ingresso já passam disso. Por isso a classe do evento e os objetos dos ingressos são
// gravados antes pela API REST (insert; se já existem, update com os dados atuais) e o
// JWT só referencia os ids dos objetos. Com GOOGLE_WALLET_ROTATING_QR, o objeto leva um QR
// rotativo (TOTP gerado pelo próprio Google, formato EB3, validação online na portaria);
// sem ele, o passe é só comprovante. Um objeto por versão do QR: na transferência o novo
// titular salva outro objeto, e o do titular anterior (QR antigo) vira INACTIVE pelo
// cron (passes.ts) — nunca recebe o QR novo.
import "server-only";
import { createSign } from "node:crypto";
import type { GoogleWalletConfig } from "./config";
import { deriveWalletTotpKey } from "../../crypto";
import { env } from "../../env";
import { QR_STEP_MS, WALLET_QR_PREFIX, WALLET_TOTP_DIGITS } from "@/lib/qr-payload";
import type { WalletTicket } from "./types";
import { BRAND, BRAND_COLORS } from "@/lib/brand";

const SAVE_URL = "https://pay.google.com/gp/v/save/";
const TOKEN_URL = "https://oauth2.googleapis.com/token";
const API_URL = "https://walletobjects.googleapis.com/walletobjects/v1";
const SCOPE = "https://www.googleapis.com/auth/wallet_object.issuer";
const BRAND_HEX = BRAND_COLORS.night;

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

/** Id do objeto de um ingresso numa versão do QR. */
export const googleObjectId = (cfg: Pick<GoogleWalletConfig, "issuerId">, code: string, tokenVersion: number) =>
  `${cfg.issuerId}.ingresso-${suffix(code)}-v${tokenVersion}`;

/**
 * QR rotativo do passe (recurso do Google que exige aprovação do emissor): o Google gera
 * `EB3:<código>:<segundos>:<TOTP>` a cada QR_STEP_MS com o segredo do ingresso (hex), e a
 * portaria confere online (checkin.ts). O segredo muda com a versão do QR (transferência).
 */
export function walletRotatingBarcode(code: string, tokenVersion: number) {
  return {
    type: "QR_CODE",
    renderEncoding: "UTF_8",
    valuePattern: `${WALLET_QR_PREFIX}:${code}:{totp_timestamp_seconds}:{totp_value_0}`,
    totpDetails: {
      periodMillis: String(QR_STEP_MS),
      algorithm: "TOTP_SHA1",
      parameters: [{ key: deriveWalletTotpKey(code, tokenVersion).toString("hex"), valueLength: WALLET_TOTP_DIGITS }],
    },
    alternateText: code,
  };
}

/** Classes (uma por evento) e objetos (um por ingresso) gravados na API do Google Wallet. */
export function googleWalletResources(tickets: WalletTicket[], cfg: GoogleWalletConfig) {
  const classes = new Map<string, Resource>();
  const objects: Resource[] = tickets.map((t) => {
    const classId = `${cfg.issuerId}.evento-${suffix(t.eventId)}`;
    if (!classes.has(classId)) {
      classes.set(classId, {
        id: classId,
        issuerName: BRAND.name,
        reviewStatus: "UNDER_REVIEW",
        eventName: text(t.event.title),
        venue: { name: text(t.event.place || "Local a definir"), address: text(t.event.place || "Local a definir") },
        dateTime: { start: t.event.startsAt.toISOString(), end: t.event.endsAt.toISOString() },
        hexBackgroundColor: BRAND_HEX,
      });
    }
    return {
      id: googleObjectId(cfg, t.code, t.tokenVersion),
      classId,
      state: "ACTIVE",
      ticketHolderName: t.holderName ?? undefined,
      ticketNumber: t.code,
      ticketType: text(t.kind === "HALF_PRICE" ? `${t.ticketTypeName} (meia-entrada: documento na entrada)` : t.ticketTypeName),
      ...(env().GOOGLE_WALLET_ROTATING_QR ? { rotatingBarcode: walletRotatingBarcode(t.code, t.tokenVersion) } : {}),
      textModulesData: [
        env().GOOGLE_WALLET_ROTATING_QR
          ? { id: "entrada", header: "Entrada", body: "Mostre o QR deste passe na portaria: ele muda a cada 30 segundos (print não vale). Precisa de internet na portaria." }
          : { id: "entrada", header: "Entrada", body: "Abra o ingresso no app/site para mostrar o QR de entrada (muda a cada 30 s). Este passe é comprovante." },
        ...(t.isSimulated ? [{ id: "teste", header: "Ingresso de teste", body: "Pagamento simulado: sem validade real." }] : []),
      ],
      hexBackgroundColor: BRAND_HEX,

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

/** Muda o estado de um objeto já gravado (ACTIVE, COMPLETED ou INACTIVE). Objeto inexistente: nada a fazer. */
export async function setGoogleObjectState(
  objectId: string,
  state: "ACTIVE" | "COMPLETED" | "INACTIVE",
  cfg: GoogleWalletConfig,
  fetchImpl: typeof fetch = fetch,
  now = new Date(),
): Promise<void> {
  const token = await accessToken(cfg, fetchImpl, now);
  const res = await fetchImpl(`${API_URL}/eventTicketObject/${encodeURIComponent(objectId)}`, {
    method: "PATCH",
    headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
    body: JSON.stringify({ state }),
  });
  if (res.status === 404) return;
  if (!res.ok) throw new Error(`Google Wallet: falha ao mudar o estado de ${objectId} (${res.status}) ${await res.text()}`);
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
