import "server-only";
import { createCipheriv, createDecipheriv, randomBytes, createHash } from "node:crypto";
import { z } from "zod";
import type { Db, Tx } from "../db";
import type { Actor } from "../auth/permissions";
import { assertOrgPermission } from "../auth/permissions";
import { hashToken, randomToken, safeEqual } from "../crypto";
import { env } from "../env";
import { AppError } from "../errors";

export const MP_COOKIE = "eb_mp_oauth";
export const MP_TTL = 600;
const failure = () => new AppError("PROVIDER_ERROR", "NÃ£o foi possÃ­vel conectar o Mercado Pago. Inicie uma nova conexÃ£o.");
const flowSchema = z.object({ state: z.string(), verifier: z.string(), actorId: z.string(), organizationId: z.string(), redirectUri: z.string().url(), expires: z.number() });
const tokenSchema = z.object({
  access_token: z.string().min(1), refresh_token: z.string().min(1),
  token_type: z.string().refine(v => v.toLowerCase() === "bearer"),
  expires_in: z.number().int().positive().max(366 * 86400),
  user_id: z.union([z.string().min(1), z.number().int().positive()]).transform(String),
  scope: z.string().refine(v => v.split(/\s+/).includes("offline_access")),
});
export function oauthConfig() {
  const e = env();
  if (!e.MERCADO_PAGO_CLIENT_ID || !e.MERCADO_PAGO_CLIENT_SECRET) throw failure();
  // Real seller credentials must never use the development fallback key.
  if (!e.MERCADO_PAGO_TOKEN_ENCRYPTION_KEY || Buffer.from(e.MERCADO_PAGO_TOKEN_ENCRYPTION_KEY, "base64").length !== 32) throw failure();
  const base = new URL(e.APP_URL);
  if (base.protocol !== "https:" && !(e.NODE_ENV !== "production" && base.hostname === "localhost")) throw failure();
  return { clientId: e.MERCADO_PAGO_CLIENT_ID, clientSecret: e.MERCADO_PAGO_CLIENT_SECRET, redirectUri: new URL("/api/mercadopago/callback", base).href };
}
export function readFlow(cookie: string, state: string, actorId: string) {
  try {
    const flow = flowSchema.parse(JSON.parse(unseal(cookie)));
    if (flow.expires <= Date.now() || flow.actorId !== actorId || !safeEqual(flow.state, state) || flow.redirectUri !== oauthConfig().redirectUri) throw failure();
    return flow;
  } catch { throw failure(); }
}
async function authorize(tx: Db | Tx, actor: Actor, organizationId: string) {
  // Re-read the user and membership: callback permission may have changed since connect.
  const user = await tx.user.findUnique({ where: { id: actor.id }, select: { status: true } });
  if (user?.status !== "ACTIVE") throw new AppError("FORBIDDEN", "Conta indisponÃ­vel.");
  const member = await assertOrgPermission(tx, actor, organizationId, "org:manage");
  if (member.organization.status !== "APPROVED") throw new AppError("FORBIDDEN", "A organizaÃ§Ã£o precisa estar aprovada.");
}
export async function beginConnection(db: Db, actor: Actor, organizationId: string) {
  const cfg = oauthConfig();
  await authorize(db, actor, organizationId);
  const state = randomToken(32), verifier = randomToken(48);
  const expires = Date.now() + MP_TTL * 1000;
  await db.mercadoPagoOAuthState.create({ data: { organizationId, actorUserId: actor.id, stateHash: hashToken(state), expiresAt: new Date(expires) } });
  const url = new URL("https://auth.mercadopago.com.br/authorization");
  url.search = new URLSearchParams({ client_id: cfg.clientId, response_type: "code", platform_id: "mp", redirect_uri: cfg.redirectUri, state, code_challenge: createHash("sha256").update(verifier).digest("base64url"), code_challenge_method: "S256" }).toString();
  return { url: url.href, cookie: seal(JSON.stringify({ state, verifier, actorId: actor.id, organizationId, redirectUri: cfg.redirectUri, expires })) };
}
/** Credenciais de sandbox na conexão OAuth: só com MERCADO_PAGO_OAUTH_TEST_TOKEN e nunca em produção. */
export const sandboxTokens = () => env().MERCADO_PAGO_OAUTH_TEST_TOKEN && env().NODE_ENV !== "production";
async function requestTokens(fields: Record<string, string>) {
  const cfg = oauthConfig();
  let response: Response;
  try {
    response = await fetch("https://api.mercadopago.com/oauth/token", { method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded", Accept: "application/json" }, body: new URLSearchParams({ client_id: cfg.clientId, client_secret: cfg.clientSecret, ...fields }), signal: AbortSignal.timeout(10000), cache: "no-store", redirect: "error" });
  } catch { throw failure(); }
  const body = await response.json().catch(() => null);
  if (!response.ok) {
    if (response.status === 400 && body?.error === "invalid_grant") throw new AppError("INVALID_STATE", "A autorizaÃ§Ã£o expirou ou foi revogada. Conecte novamente.");
    throw failure();
  }
  const parsed = tokenSchema.safeParse(body);
  if (!parsed.success) throw failure();
  return parsed.data;
}
type Tokens = z.infer<typeof tokenSchema>;
function stored(tokens: Tokens) {
  return { mercadoPagoUserId: tokens.user_id, accessTokenEncrypted: seal(tokens.access_token), refreshTokenEncrypted: seal(tokens.refresh_token), tokenExpiresAt: new Date(Date.now() + tokens.expires_in * 1000), revokedAt: null };
}
// Same database lock for connect and refresh, including across server processes.
async function lock(tx: Tx, organizationId: string) {
  await tx.$queryRaw`SELECT pg_advisory_xact_lock(hashtextextended(${"mp-oauth:" + organizationId}, 0))::text`;
}
export async function finishConnection(db: Db, actor: Actor, cookie: string, state: string, code: string | null, denied = false) {
  const flow = readFlow(cookie, state, actor.id);
  await authorize(db, actor, flow.organizationId);
  const claimed = await db.mercadoPagoOAuthState.updateMany({ where: { stateHash: hashToken(state), actorUserId: actor.id, organizationId: flow.organizationId, consumedAt: null, expiresAt: { gt: new Date() } }, data: { consumedAt: new Date() } });
  if (claimed.count !== 1) throw failure();
  if (denied) return "denied" as const;
  if (!code || code.length > 2048) throw failure();
  await db.$transaction(async tx => {
    await lock(tx, flow.organizationId);
    // test_token=true: o Mercado Pago devolve credenciais de sandbox do vendedor (documentação de OAuth).
    const tokens = await requestTokens({ grant_type: "authorization_code", code, redirect_uri: flow.redirectUri, state, code_verifier: flow.verifier, test_token: sandboxTokens() ? "true" : "false" });
    await authorize(tx, actor, flow.organizationId);
    const data = stored(tokens);
    await tx.mercadoPagoAccount.upsert({ where: { organizationId: flow.organizationId }, create: { organizationId: flow.organizationId, ...data }, update: { ...data, connectedAt: new Date() } });
    // OAuth linkage is independent of the active payment provider and settlement flags.
  }, { maxWait: 5000, timeout: 20000 });
  return "connected" as const;
}
/** Server-only capability. Resolve organization from the trusted order, never a browser parameter. */
export async function getMercadoPagoAccessToken(db: Db, organizationId: string) {
  const outcome = await db.$transaction(async tx => {
    await lock(tx, organizationId);
    const org = await tx.organization.findUnique({ where: { id: organizationId }, select: { status: true } });
    const account = await tx.mercadoPagoAccount.findUnique({ where: { organizationId } });
    if (org?.status !== "APPROVED" || !account || account.revokedAt) throw failure();
    if (account.tokenExpiresAt.getTime() > Date.now() + 60000) return { token: unseal(account.accessTokenEncrypted) };
    try {
      const tokens = await requestTokens({ grant_type: "refresh_token", refresh_token: unseal(account.refreshTokenEncrypted) });
      if (tokens.user_id !== account.mercadoPagoUserId) throw failure();
      await tx.mercadoPagoAccount.update({ where: { organizationId }, data: stored(tokens) });
      return { token: tokens.access_token };
    } catch (err) {
      if (err instanceof AppError && err.code === "INVALID_STATE") {
        await tx.mercadoPagoAccount.update({ where: { organizationId }, data: { revokedAt: new Date() } });
        return { token: null };
      }
      throw failure();
    }
  }, { maxWait: 15000, timeout: 20000 });
  if (!outcome.token) throw new AppError("INVALID_STATE", "Conecte novamente sua conta Mercado Pago.");
  return outcome.token;
}

export async function getMercadoPagoAccessTokenForUser(db: Db, mercadoPagoUserId: string) {
  const account = await db.mercadoPagoAccount.findFirst({
    where: { mercadoPagoUserId, revokedAt: null, organization: { status: "APPROVED" } },
    select: { organizationId: true },
  });
  if (!account) throw failure();
  return getMercadoPagoAccessToken(db, account.organizationId);
}

// Dedicated key: existing document encryption is never rotated by OAuth setup.
function key() {
  const raw = env().MERCADO_PAGO_TOKEN_ENCRYPTION_KEY;
  if (!raw || Buffer.from(raw, "base64").length !== 32) throw failure();
  return Buffer.from(raw, "base64");
}
function seal(value: string) {
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", key(), iv);
  cipher.setAAD(Buffer.from("evento-brasil:mercadopago:v1"));
  const ciphertext = Buffer.concat([cipher.update(value, "utf8"), cipher.final()]);
  return ["mp1", iv.toString("base64url"), cipher.getAuthTag().toString("base64url"), ciphertext.toString("base64url")].join(".");
}
function unseal(value: string) {
  const [version, iv, tag, ciphertext, extra] = value.split(".");
  if (version !== "mp1" || !iv || !tag || !ciphertext || extra) throw failure();
  const decipher = createDecipheriv("aes-256-gcm", key(), Buffer.from(iv, "base64url"));
  decipher.setAAD(Buffer.from("evento-brasil:mercadopago:v1"));
  decipher.setAuthTag(Buffer.from(tag, "base64url"));
  return Buffer.concat([decipher.update(Buffer.from(ciphertext, "base64url")), decipher.final()]).toString("utf8");
}
