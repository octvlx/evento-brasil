import "server-only";
import { createHash, createHmac, randomBytes } from "node:crypto";
import { z } from "zod";
import { isValidMobileBR, onlyDigits } from "@/lib/br";
import type { Db, Tx } from "../db";
import { env } from "../env";
import { AppError } from "../errors";
import { TwilioVerifyProvider, type PhoneVerificationProvider } from "../phone-verification/twilio";

const identity = z.object({ email: z.string().trim().toLowerCase().email().max(254), phone: z.string().max(40) });
const token = z.string().regex(/^[A-Za-z0-9_-]{43}$/);
const invalid = () => new AppError("VALIDATION", "Verifique seu celular novamente para concluir o cadastro.");
const limited = () => new AppError("RATE_LIMITED", "Muitas tentativas. Aguarde antes de solicitar outro código.");
const hashToken = (value: string) => createHash("sha256").update(value).digest("hex");
export function normalizeSignupPhone(raw: string) {
  if (!isValidMobileBR(raw)) throw new AppError("VALIDATION", "Informe um celular brasileiro com DDD.");
  const digits = onlyDigits(raw);
  return `+${digits.length === 13 ? digits : `55${digits}`}`;
}
function parseIdentity(raw: unknown) {
  const parsed = identity.safeParse(raw);
  if (!parsed.success) throw invalid();
  return { email: parsed.data.email, phone: normalizeSignupPhone(parsed.data.phone) };
}
function clientHash(ip?: string | null) {
  return createHmac("sha256", env().AUTH_SECRET).update(`signup-sms:${ip || "unknown"}`).digest("hex");
}
async function lock(tx: Tx, key: string) {
  await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${key}, 0))`;
}

/** Durably reserve a send before calling the provider; failures still count against abuse limits. */
export async function startSignupPhoneVerification(db: Db, raw: { email: string; phone: string; smsConsent: true }, client: { ip?: string | null } = {}, provider: PhoneVerificationProvider = new TwilioVerifyProvider()) {
  const { email, phone } = parseIdentity(raw);
  if (raw.smsConsent !== true) throw new AppError("VALIDATION", "Autorize o envio do código por SMS para verificar seu celular.");
  const clientKeyHash = clientHash(client.ip);
  const challengeToken = randomBytes(32).toString("base64url");
  const now = new Date();
  const expiresAt = new Date(now.getTime() + 10 * 60_000);
  const challenge = await db.$transaction(async (tx) => {
    // Consistent ordering prevents deadlocks across callers sharing phone or IP.
    for (const key of [`signup-phone:${phone}`, `signup-client:${clientKeyHash}`].sort()) await lock(tx, key);
    const hourAgo = new Date(now.getTime() - 60 * 60_000);
    const dayAgo = new Date(now.getTime() - 24 * 60 * 60_000);
    const [phoneCount, clientCount, phoneDailyCount, clientDailyCount, recent] = await Promise.all([
      tx.phoneVerificationChallenge.count({ where: { phone, createdAt: { gte: hourAgo } } }),
      tx.phoneVerificationChallenge.count({ where: { clientKeyHash, createdAt: { gte: hourAgo } } }),
      tx.phoneVerificationChallenge.count({ where: { phone, createdAt: { gte: dayAgo } } }),
      tx.phoneVerificationChallenge.count({ where: { clientKeyHash, createdAt: { gte: dayAgo } } }),
      tx.phoneVerificationChallenge.findFirst({ where: { phone }, orderBy: { createdAt: "desc" }, select: { lastSentAt: true } }),
    ]);
    if (phoneCount >= 5 || clientCount >= 20 || phoneDailyCount >= 10 || clientDailyCount >= 100 || (recent?.lastSentAt && now.getTime() - recent.lastSentAt.getTime() < 30_000)) throw limited();
    await tx.phoneVerificationChallenge.updateMany({ where: { email, phone, consumedAt: null, expiresAt: { gt: now } }, data: { expiresAt: now } });
    return tx.phoneVerificationChallenge.create({ data: { tokenHash: hashToken(challengeToken), email, phone, clientKeyHash, expiresAt, smsConsentAt: now, sendCount: 1, lastSentAt: now } });
  });
  const verificationSid = await provider.start(phone);
  const sent = await db.phoneVerificationChallenge.updateMany({ where: { id: challenge.id, expiresAt: { gt: new Date() }, consumedAt: null }, data: { providerVerificationSid: verificationSid } });
  if (sent.count !== 1) throw invalid();
  return { challengeToken, expiresAt: expiresAt.toISOString(), resendAfterSeconds: 30 as const };
}

export async function verifySignupPhoneVerification(db: Db, raw: { email: string; phone: string; challengeToken: string; code: string }, _client: { ip?: string | null } = {}, provider: PhoneVerificationProvider = new TwilioVerifyProvider()) {
  void _client;
  const { email, phone } = parseIdentity(raw);
  if (!token.safeParse(raw.challengeToken).success || !/^\d{6}$/.test(raw.code)) throw invalid();
  // Reserve attempts in a short transaction; invalid codes/provider failures must not roll back the counter.
  const challenge = await db.$transaction(async (tx) => {
    const current = await tx.phoneVerificationChallenge.findUnique({ where: { tokenHash: hashToken(raw.challengeToken) } });
    if (!current || current.email !== email || current.phone !== phone || !current.providerVerificationSid || current.consumedAt || current.expiresAt <= new Date()) throw invalid();
    if (current.verifiedAt) return current;
    const reserved = await tx.phoneVerificationChallenge.updateMany({ where: { id: current.id, checkCount: { lt: 5 }, consumedAt: null, verifiedAt: null, expiresAt: { gt: new Date() } }, data: { checkCount: { increment: 1 } } });
    if (reserved.count !== 1) throw limited();
    return current;
  });
  if (challenge.verifiedAt) return { verified: true as const };
  if (!await provider.check(challenge.providerVerificationSid!, phone, raw.code)) throw new AppError("VALIDATION", "Código incorreto ou expirado.");
  const approved = await db.phoneVerificationChallenge.updateMany({ where: { id: challenge.id, consumedAt: null, expiresAt: { gt: new Date() } }, data: { verifiedAt: new Date() } });
  if (approved.count !== 1) throw invalid();
  return { verified: true as const };
}

/** Must run in the same transaction as user creation, so a proof can create at most one account. */
export async function consumeSignupPhoneVerification(tx: Tx, raw: { email: string; phone?: string; phoneVerificationToken?: string }) {
  if (!raw.phone || !raw.phoneVerificationToken || !token.safeParse(raw.phoneVerificationToken).success) throw invalid();
  const { email, phone } = parseIdentity({ email: raw.email, phone: raw.phone });
  const now = new Date();
  const proof = await tx.phoneVerificationChallenge.findUnique({ where: { tokenHash: hashToken(raw.phoneVerificationToken) } });
  if (!proof || proof.email !== email || proof.phone !== phone || !proof.verifiedAt) throw invalid();
  const consumed = await tx.phoneVerificationChallenge.updateMany({ where: { id: proof.id, consumedAt: null, verifiedAt: { not: null }, expiresAt: { gt: now } }, data: { consumedAt: now } });
  if (consumed.count !== 1) throw invalid();
  return { phone, phoneVerifiedAt: proof.verifiedAt, smsConsentAt: proof.smsConsentAt };
}

/** Short-lived signup PII is retained for 24 hours to enforce rolling abuse limits. */
export async function cleanupSignupPhoneChallenges(db: Db, now = new Date()) {
  return db.phoneVerificationChallenge.deleteMany({ where: { createdAt: { lt: new Date(now.getTime() - 24 * 60 * 60_000) }, expiresAt: { lt: now } } });
}
