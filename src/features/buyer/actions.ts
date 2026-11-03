"use server";

import { refresh } from "next/cache";
import { headers } from "next/headers";
import { requireUser } from "@/server/auth/current";
import { db } from "@/server/db";
import { AppError, toActionResult } from "@/server/errors";
import { rateLimit } from "@/server/rate-limit";
import { saveBuyerAddress, saveBuyerPersonalData } from "@/server/services/buyer-profile";
import { lookupPostalAddress } from "@/server/services/postal-address";
import { buyerAddressSchema, buyerPersonalSchema, type BuyerAddressInput, type BuyerPersonalInput } from "./schemas";

export async function saveBuyerPersonalAction(raw: BuyerPersonalInput) {
  const actor = await requireUser();
  return toActionResult(async () => {
    await rateLimit(`buyer-personal:${actor.id}`, 20, 60_000);
    const parsed = buyerPersonalSchema.safeParse(raw);
    if (!parsed.success) throw new AppError("VALIDATION", parsed.error.issues[0]?.message ?? "Confira seus dados.");
    await saveBuyerPersonalData(db, actor, parsed.data);
    refresh();
  });
}

export async function saveBuyerAddressAction(raw: BuyerAddressInput) {
  const actor = await requireUser();
  return toActionResult(async () => {
    await rateLimit(`buyer-address:${actor.id}`, 20, 60_000);
    const parsed = buyerAddressSchema.safeParse(raw);
    if (!parsed.success) throw new AppError("VALIDATION", parsed.error.issues[0]?.message ?? "Confira seu endereço.");
    await saveBuyerAddress(db, actor, parsed.data);
    refresh();
  });
}

export async function lookupPostalAddressAction(postalCode: string) {
  const actor = await requireUser();
  return toActionResult(async () => {
    const client = (await headers()).get("x-forwarded-for")?.split(",")[0]?.trim() ?? "local";
    await rateLimit(`buyer-cep:${actor.id}:${client}`, 20, 60_000);
    return lookupPostalAddress(postalCode);
  });
}
