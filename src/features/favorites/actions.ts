"use server";

import { z } from "zod";
import { getCurrentUser } from "@/server/auth/current";
import { db } from "@/server/db";
import { AppError, toActionResult } from "@/server/errors";
import { rateLimit } from "@/server/rate-limit";
import { setEventFavorite, setOrganizerFollow } from "@/server/services/favorites";

const input = z.object({ id: z.string().min(1).max(64), on: z.boolean() });

// Sem login, o botão manda para /entrar (o componente trata o código UNAUTHENTICATED).
async function actor() {
  const user = await getCurrentUser();
  if (!user) throw new AppError("UNAUTHENTICATED", "Entre na sua conta para salvar.");
  return user;
}

export async function setEventFavoriteAction(raw: { id: string; on: boolean }) {
  return toActionResult(async () => {
    const user = await actor();
    await rateLimit(`favorite:${user.id}`, 60, 60_000);
    const parsed = input.safeParse(raw);
    if (!parsed.success) throw new AppError("VALIDATION", "Pedido inválido.");
    const { id, on } = parsed.data;
    return setEventFavorite(db, user, id, on);
  });
}

export async function setOrganizerFollowAction(raw: { id: string; on: boolean }) {
  return toActionResult(async () => {
    const user = await actor();
    await rateLimit(`follow:${user.id}`, 60, 60_000);
    const parsed = input.safeParse(raw);
    if (!parsed.success) throw new AppError("VALIDATION", "Pedido inválido.");
    const { id, on } = parsed.data;
    return setOrganizerFollow(db, user, id, on);
  });
}
