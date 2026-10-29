// Test fixture only: production registration never seeds verification proofs.
import { randomBytes, createHash } from "node:crypto";
import { db } from "./fixtures";

export async function verifiedSignup(email: string) {
  const phoneVerificationToken = randomBytes(32).toString("base64url");
  const now = new Date();
  await db.phoneVerificationChallenge.create({ data: {
    tokenHash: createHash("sha256").update(phoneVerificationToken).digest("hex"),
    email: email.trim().toLowerCase(), phone: "+5511912345678",
    clientKeyHash: "a".repeat(64), smsConsentAt: now, verifiedAt: now,
    expiresAt: new Date(now.getTime() + 600000),
  } });
  return { phone: "+5511912345678", smsConsent: true as const, phoneVerificationToken };
}
