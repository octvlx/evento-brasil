"use server";

import { refresh } from "next/cache";
import { z } from "zod";
import { requireUser } from "@/server/auth/current";
import { db } from "@/server/db";
import { AppError, toActionResult } from "@/server/errors";
import { rateLimit } from "@/server/rate-limit";
import { REVIEW_COMMENT_MAX, submitReview } from "@/server/services/reviews";

const schema = z.object({
  eventId: z.string().min(1).max(64),
  rating: z.number().int().min(1).max(5),
  comment: z.string().max(REVIEW_COMMENT_MAX).optional(),
});

export async function submitReviewAction(raw: { eventId: string; rating: number; comment?: string }) {
  const actor = await requireUser();
  return toActionResult(async () => {
    await rateLimit(`review:${actor.id}`, 10, 60_000);
    const parsed = schema.safeParse(raw);
    if (!parsed.success) throw new AppError("VALIDATION", "Escolha uma nota de 1 a 5 e use até 1000 caracteres no comentário.");
    await submitReview(db, actor, parsed.data.eventId, parsed.data);
    refresh();
  });
}
