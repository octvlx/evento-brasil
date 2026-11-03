"use server";

import { cookies, headers } from "next/headers";
import { refresh } from "next/cache";
import { z } from "zod";
import { db } from "@/server/db";
import { getCurrentUser, requireUser } from "@/server/auth/current";
import { env } from "@/server/env";
import { AppError, toActionResult } from "@/server/errors";
import { rateLimit } from "@/server/rate-limit";
import { createCheckoutDraft, prepareCheckoutReview, updateCheckoutDraft, confirmCheckoutReview } from "@/server/services/checkout-review";
import type { CreateOrderInput } from "@/features/schemas";
import { ATTR_COOKIE, decodeAttribution } from "./attribution";

const draftIdSchema = z.string().min(1).max(128).regex(/^[A-Za-z0-9_-]+$/);
async function requestClient() { const h = await headers(); return { ip: h.get("x-forwarded-for")?.split(",")[0]?.trim() || h.get("x-real-ip") || "local", userAgent: h.get("user-agent") ?? undefined }; }
async function draftToken(draftId: string) {
  if (!draftIdSchema.safeParse(draftId).success) throw new AppError("VALIDATION", "Checkout inválido.");
  return (await cookies()).get(`eb_checkout_${draftId}`)?.value;
}

export async function startCheckoutDraftAction(input: CreateOrderInput) {
  return toActionResult(async () => {
    const actor = await getCurrentUser(); const client = await requestClient();
    await rateLimit(`checkout-draft:${actor?.id ?? client.ip}`, 20, 60_000);
    const attribution = decodeAttribution((await cookies()).get(ATTR_COOKIE)?.value);
    const draft = await createCheckoutDraft(db, { ...input, attribution }, actor);
    (await cookies()).set(`eb_checkout_${draft.draftId}`, draft.token, { httpOnly: true, secure: env().NODE_ENV === "production", sameSite: "lax", path: "/", maxAge: 24 * 60 * 60 });
    return { draftId: draft.draftId };
  });
}

export async function prepareCheckoutReviewAction(draftId: string) {
  const actor = await requireUser(`/checkout/revisao/${draftId}`);
  return toActionResult(async () => {
    await rateLimit(`checkout-prepare:${actor.id}`, 20, 60_000);
    await prepareCheckoutReview(db, actor, draftId, await draftToken(draftId));
    refresh();
  });
}

export async function updateCheckoutDraftAction(draftId: string, input: CreateOrderInput) {
  const actor = await requireUser(`/checkout/revisao/${draftId}`);
  return toActionResult(async () => {
    await rateLimit(`checkout-edit:${actor.id}`, 20, 60_000);
    const attribution = decodeAttribution((await cookies()).get(ATTR_COOKIE)?.value);
    await updateCheckoutDraft(db, actor, draftId, { ...input, attribution }, await draftToken(draftId));
    refresh();
  });
}

export async function confirmCheckoutReviewAction(draftId: string, reviewHash: string, acceptTerms?: boolean) {
  const actor = await requireUser(`/checkout/revisao/${draftId}`);
  return toActionResult(async () => {
    await rateLimit(`checkout-confirm:${actor.id}`, 20, 60_000);
    const client = await requestClient();
    const result = await confirmCheckoutReview(db, actor, draftId, reviewHash, await draftToken(draftId), { acceptTerms, ...client });
    refresh();
    return result;
  });
}
